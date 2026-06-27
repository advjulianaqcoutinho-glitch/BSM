// ═══════════════════════════════════════════════════════════════════════════════
// Cloudflare Worker — Webhook Kiwify → Supabase → Meta CAPI
// Domínio: webhook.aceleracaocontabil.com.br
// Operação: Balancete Sem Medo
//
// NOTA: recuperação via WhatsApp removida (descontinuada).
//   - Sem RECOVERY_DELAYS / agendarRecuperacao / cancelarFilaPorEmail
//   - Sem escritas na tabela bsm_fila_mensagens
//   O Worker agora só: valida store, deduplica, salva transação no Supabase
//   e dispara o evento para o Meta CAPI (Purchase / AddPaymentInfo).
// ═══════════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://eqdvnkmjdyrfvpkdmajf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxZHZua21qZHlyZnZwa2RtYWpmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzE2MzU5NywiZXhwIjoyMDg4NzM5NTk3fQ.tW-QYAAY-68P6MdK9SVXsd3XLLkZ5VOWijk5wClPbvc';

const PIXEL_ID   = '1639582400367325';
const CAPI_TOKEN = 'EAALZAPt6fiWEBQq4LYhZAZBYzFOe5fZAKo9cAiIgHyKyxsVDAwl2lbuiZBoaWFHR1qvhxrbMG6pirGUSoBgwkZAreOccRDBs2r5zlnQ0mUlJWF3EHT3WYze87SXmugQXQsZAZBVHisEzECo63G3zDvGrGZBzxFs60hZBwErErksD3M2FNhwUrbxX9UhVHnFnndBCdccgZDZD';

const KIWIFY_STORE_ID = 'zJoKlcrTacs6QdQ';

const PRODUCT_MAP = {
  'Balancete Sem Medo':                                          { id: 'bsm_principal',         price: 47.00 },
  'Mapa Mental da Análise de Balancete':                   { id: 'bsm_bump_mapa_mental',  price: 17.00 },
  'Erros Mais Comuns na Análise de Balancete (e como evitar)': { id: 'bsm_bump_erros_comuns', price: 17.00 },
  'Rotina de Análise em 15 Minutos (Plano Semanal)':       { id: 'bsm_bump_rotina_15min', price: 17.00 },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────
async function hashData(text) {
  if (!text) return undefined;
  const clean = text.trim().toLowerCase();
  const buf   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clean));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeExternalId(id) {
  if (!id) return null;
  return id.trim().toLowerCase();
}

function cleanPhone(phone) {
  if (!phone) return undefined;
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('55') && cleaned.length >= 12) {
    cleaned = cleaned.substring(2);
  }
  return '55' + cleaned;
}

function parseUtmifyParam(value) {
  if (!value) return { name: null, id: null };
  const parts = value.split('|');
  return { name: parts[0]?.trim() || null, id: parts[1]?.trim() || null };
}

async function logMetaEvent(transactionId, eventName, eventId, metaResponse, success) {
  await fetch(`${SUPABASE_URL}/rest/v1/bsm_eventos_meta`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    },
    body: JSON.stringify({ transaction_id: transactionId, event_name: eventName, event_id: eventId, meta_response: metaResponse, success })
  }).catch(e => console.log('Erro log Meta:', e));
}

// ─── HANDLER: CARRINHO ABANDONADO ─────────────────────────────────────────────
// Mantém apenas o registro no Supabase para análise (sem disparo de WhatsApp).
async function handleCarrinhoAbandonado(payload) {
  const cart = (payload.cart && payload.cart.id) ? payload.cart : payload;

  if (cart.store_id && cart.store_id !== KIWIFY_STORE_ID) {
    return new Response('Unauthorized', { status: 401 });
  }

  await fetch(`${SUPABASE_URL}/rest/v1/bsm_carrinhos_abandonados`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      cart_id:        cart.id,
      store_id:       cart.store_id,
      product_id:     cart.product_id,
      product_name:   cart.product_name,
      offer_name:     cart.offer_name,
      customer_name:  cart.name,
      customer_email: cart.email,
      customer_phone: cleanPhone(cart.phone),
      customer_cpf:   cart.cpf,
      country:        cart.country,
      checkout_link:  cart.checkout_link,
      status:         cart.status,
      raw_payload:    cart
    })
  }).catch(e => console.log('Erro salvar carrinho:', e));

  return new Response(JSON.stringify({ success: true, info: 'carrinho_abandonado_registrado' }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

// ─── HANDLER: PEDIDO (PIX/CARTÃO/APROVADO/REEMBOLSO) ─────────────────────────
async function handleOrder(payload) {
  const order    = payload.order || {};
  const customer = order.Customer          || {};
  const tracking = order.TrackingParameters || {};
  const product  = order.Product           || {};
  const commissions = order.Commissions    || {};

  if (order.store_id && order.store_id !== KIWIFY_STORE_ID) {
    return new Response('Unauthorized', { status: 401 });
  }

  const webhookEventType = order.webhook_event_type || '';
  const orderStatus      = order.order_status       || '';
  const transactionId    = order.order_id;

  if (!transactionId) {
    return new Response('Ignorado: sem order_id', { status: 200 });
  }

  // Idempotência para Purchase
  if (webhookEventType === 'order_approved') {
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bsm_transacoes_kiwify?transaction_id=eq.${transactionId}&status=eq.paid&select=transaction_id`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const existing = await checkRes.json();
    if (existing && existing.length > 0) {
      console.log('Webhook duplicado ignorado:', transactionId);
      return new Response(JSON.stringify({ success: true, info: 'duplicate_ignored' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  const productName = product.product_name || '';
  const productInfo = PRODUCT_MAP[productName] || {
    id:    'bsm_produto_' + productName.toLowerCase().replace(/\s+/g, '_').substring(0, 30),
    price: commissions.product_base_price ? commissions.product_base_price / 100 : 0
  };

  const totalValue    = commissions.product_base_price ? commissions.product_base_price / 100 : productInfo.price;
  const externalIdRaw = tracking.src || null;
  const externalId    = normalizeExternalId(externalIdRaw);

  const utmSource   = tracking.utm_source   || null;
  const utmMedium   = tracking.utm_medium   || null;
  const utmCampaign = tracking.utm_campaign || null;
  const utmContent  = tracking.utm_content  || null;
  const utmTerm     = tracking.utm_term     || null;

  const campaign = parseUtmifyParam(utmCampaign);
  const adset    = parseUtmifyParam(utmMedium);
  const ad       = parseUtmifyParam(utmContent);

  // Data Stitching — recupera dados da sessão da LP pelo external_id
  let fbp, fbc, sessionIp, userAgent, sourceUrl;
  if (externalId) {
    const sessionRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bsm_sessoes_lp?external_id=eq.${externalId}&select=fbp,fbc,ip_address,user_agent,source_url`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const sessions = await sessionRes.json();
    if (sessions && sessions.length > 0) {
      fbp       = sessions[0].fbp;
      fbc       = sessions[0].fbc;
      sessionIp = sessions[0].ip_address;
      userAgent = sessions[0].user_agent;
      sourceUrl = sessions[0].source_url;
    }
  }

  const clientIp       = customer.ip || sessionIp || undefined;
  const eventSourceUrl = sourceUrl || 'https://aceleracaocontabil.com.br';

  // Determina evento Meta e status interno
  let eventName, statusSupabase;
  if (webhookEventType === 'order_approved' || orderStatus === 'paid') {
    eventName      = 'Purchase';
    statusSupabase = 'paid';
  } else if (
    webhookEventType === 'order_waiting_payment' ||
    webhookEventType === 'pix_created' ||
    webhookEventType === 'boleto_created' ||
    orderStatus === 'waiting_payment'
  ) {
    eventName      = 'AddPaymentInfo';
    statusSupabase = 'waiting_payment';
  } else if (webhookEventType === 'order_refunded' || orderStatus === 'refunded') {
    eventName      = null;
    statusSupabase = 'refunded';
  } else if (webhookEventType === 'order_chargeback' || orderStatus === 'chargedback') {
    eventName      = null;
    statusSupabase = 'chargedback';
  } else {
    return new Response(JSON.stringify({ success: true, info: 'event_ignored', status: orderStatus }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Salva transação
  await fetch(`${SUPABASE_URL}/rest/v1/bsm_transacoes_kiwify`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      transaction_id:     transactionId,
      external_id:        externalId,
      status:             statusSupabase,
      customer_name:      customer.full_name    || null,
      customer_email:     customer.email        || null,
      customer_phone:     cleanPhone(customer.mobile) || null,
      customer_cpf:       customer.CPF          || null,
      customer_ip:        clientIp              || null,
      customer_country:   customer.country      || null,
      total_value:        totalValue,
      payment_method:     order.payment_method  || null,
      product_id:         product.product_id    || null,
      product_name:       productName           || null,
      installments:       order.installments    || null,
      card_type:          order.card_type       || null,
      webhook_event_type: webhookEventType      || null,
      utm_source:         utmSource,
      utm_medium:         utmMedium,
      utm_campaign:       utmCampaign,
      utm_content:        utmContent,
      utm_term:           utmTerm,
      utm_campaign_name:  campaign.name,
      utm_campaign_id:    campaign.id,
      utm_adset_name:     adset.name,
      utm_adset_id:       adset.id,
      utm_ad_name:        ad.name,
      utm_ad_id:          ad.id,
      event_source_url:   eventSourceUrl,
      raw_payload:        order
    })
  }).catch(e => console.log('Erro Supabase transação:', e));

  // Encerra se não há evento Meta a disparar (refund/chargeback)
  if (!eventName) {
    return new Response(JSON.stringify({ success: true, info: 'logged_only', status: statusSupabase }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Hash dos dados pessoais
  const phoneClean = cleanPhone(customer.mobile);
  const [emHash, phHash, fnHash, lnHash, externalIdHash, cpfHash, countryHash] = await Promise.all([
    hashData(customer.email),
    hashData(phoneClean),
    hashData(customer.first_name),
    hashData(customer.full_name?.split(' ').slice(1).join(' ')),
    hashData(externalId),
    hashData(customer.CPF?.replace(/\D/g, '')),
    hashData(customer.country || 'br')
  ]);

  // Envia para o Meta CAPI
  const eventId = `${eventName}_${transactionId}`;
  const capiPayload = {
    data: [{
      event_name:       eventName,
      event_time:       Math.floor(Date.now() / 1000),
      event_id:         eventId,
      action_source:    'website',
      event_source_url: eventSourceUrl,
      user_data: {
        em: emHash, ph: phHash, fn: fnHash, ln: lnHash,
        external_id: externalIdHash, country: countryHash,
        client_ip_address: clientIp, client_user_agent: userAgent || undefined,
        fbp: fbp || undefined, fbc: fbc || undefined,
        f5pnt: cpfHash || undefined
      },
      custom_data: {
        currency: 'BRL', value: totalValue, content_type: 'product',
        content_ids: [productInfo.id], content_name: productName, num_items: 1,
        contents: [{ id: productInfo.id, quantity: 1, item_price: totalValue }]
      }
    }]
  };

  const metaRes    = await fetch(
    `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(capiPayload) }
  );
  const metaResult = await metaRes.json();
  const success    = metaRes.ok && !metaResult.error;

  await logMetaEvent(transactionId, eventName, eventId, metaResult, success);

  return new Response(JSON.stringify({ success, meta: metaResult }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Apenas POST aceito', { status: 405 });
    }

    let payload;
    try { payload = await request.json(); }
    catch { return new Response('JSON inválido', { status: 400 }); }

    try {
      console.log('Payload keys:', Object.keys(payload).join(', '));
      console.log('event_type:', payload.order?.webhook_event_type || payload.cart?.status || payload.webhook_event_type || payload.status || 'unknown');

      if (payload.cart && payload.cart.status === 'abandoned') {
        return await handleCarrinhoAbandonado(payload);
      } else if (payload.status === 'abandoned' && payload.phone) {
        console.log('Carrinho abandonado sem wrapper — adaptando');
        return await handleCarrinhoAbandonado({ cart: payload });
      } else if (payload.order) {
        return await handleOrder(payload);
      } else if (payload.order_id || payload.order_status) {
        console.log('Pedido sem wrapper — adaptando:', payload.order_id);
        return await handleOrder({ order: payload });
      } else {
        console.log('Payload ignorado — keys:', Object.keys(payload).join(', '));
        return new Response(JSON.stringify({ success: true, info: 'payload_ignorado', keys: Object.keys(payload) }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      console.error('Erro no webhook:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
