# Balancete Sem Medo — Landing Page (design V2 + copy V3)

Página de vendas em HTML único, otimizada para PageSpeed, com tracking avançado
(Meta Pixel + CAPI Worker), prova social, animações e gráfico.

## Como publicar na Hostgator

1. No File Manager, crie a pasta `/public_html/bsm/`.
2. Faça upload de **`index.html`** para dentro dela.
3. Faça upload da foto da Deise como **`foto-deise.jpg`** na mesma pasta.
   - Recomendado: exportar em **WebP ou JPG otimizado**, ~380×507px (proporção 3:4),
     até ~80KB. Se usar WebP, troque `foto-deise.jpg` por `foto-deise.webp` no `index.html`.
4. (Opcional) Suba um `favicon.png`.
5. Acesse: **https://aceleracaocontabil.com.br/bsm**

> O domínio `aceleracaocontabil.com.br` já está no `ALLOWED_ORIGINS` do Worker
> CAPI — o tracking funciona sem alterar nada no Cloudflare.

## Antes de subir, confira

- [ ] Link do checkout: todos os botões apontam para `https://pay.kiwify.com.br/aHYebNd`.
      Se mudar a oferta, troque no `index.html` (o script injeta UTMs + `external_id` automaticamente).
- [ ] Foto `foto-deise.jpg` no lugar.
- [ ] Pixel ID `1639582400367325` (já configurado).

## Tracking implementado

| Evento | Pixel | CAPI | Quando |
|---|---|---|---|
| PageView | ✓ | — | carga (lazy) |
| ViewContent | ✓ (dedup eventID) | ✓ | carga (lazy) |
| ScrollDepth 25/50/75/90% | ✓ custom | ✓ | rolagem |
| CTAClick | ✓ custom | ✓ | clique em qualquer CTA |
| InitiateCheckout | — | — | disparado pela Kiwify |
| Purchase / AddPaymentInfo | — | ✓ (via webhook) | webhook Kiwify |

Extras de atribuição:
- `external_id` persistente em **localStorage** (sobrevive a reaberturas).
- `fbclid` salvo em **localStorage por 7 dias** + reconstrução do `_fbc`.
- UTMs (padrão UTMify) injetados nos links da Kiwify.

## Elementos de conversão

- Âncora de preço (R$47) já no hero.
- Contador animado "286 contadoras".
- Toasts de prova social (desktop) — pool de nomes/cidades, intervalo aleatório.
- Sticky bar com CTA ao rolar.
- Scroll reveal, gráfico de tempo (antes/depois), CTA com pulse/shine.
- Respeita `prefers-reduced-motion`.

## Performance

- CSS 100% inline (zero request de CSS bloqueante).
- JS deferido; Pixel só carrega após interação ou 3.5s.
- Fontes com `display=swap` + preconnect.
- `content-visibility:auto` nas seções abaixo da dobra.
- Imagem com `width/height` + `loading=lazy` (evita CLS).
