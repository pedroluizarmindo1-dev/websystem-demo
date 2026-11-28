---
id: AUX-20261128-overlap-pr47
agente: AuxiliarCodeAgent
data: 2026-11-28
pr: 47
branch: security/wallet-cookie-hardening-20261128
base_sha: b9b516a
final_sha: 4fdaade
modulo: security
depende_de: [43, 45, 46, 47]
deploy: não publicado
---

# Sobreposição entre o #47 (principal) e a pilha #43 → #45 → #46

Análise feita pelo AuxiliarCodeAgent sobre o #47 do agente principal (`4fdaade`) e o head do #46 (`faf39ad`). Nenhum código foi alterado.

## O que o #47 muda e como afeta a pilha
- Introduz `parseCookies` (`api/cookies.mjs`) no lugar dos parsers inline de `server.mjs`, `wallet.mjs` e `client-area.mjs`.
  - A pilha herda a correção: `checkout.mjs`, `mazzopay.mjs` e `supplier-orders.mjs` não leem cookie diretamente; usam o middleware `client` exportado por `wallet.mjs`.
- Muda o limite das recargas manuais:
  - Teto de R$ 1.000 (`maxAmount=100000` centavos).
  - Máximo de 3 recargas pendentes.
  - Recusa referência PIX manual duplicada.
  - Isso é coerente com o PIX automático (`MAZZOPAY_MAX_CENTS` padrão 100000).

## Achados
| ID | Severidade | Descrição | Ação / responsável | Estado |
|---|---|---|---|---|
| AUX-20261128-22 | AVISO | Conflito de merge em `api/wallet.mjs`, no fim de `mountWallet`: o #43 adiciona `return {client};` e o #47 só muda a quebra de linha final. É o único conflito; `server.mjs` e `client-area.mjs` se combinam automaticamente. | Quem integrar por último: resolver mantendo `return {client};` antes do `}`. Sem essa linha, `walletApi.client` fica `undefined` e o PIX, o checkout e o fornecedor quebram no boot. **Resposta AUX:** Conflito resolvido no #43 (`9c281f9`) mantendo `return {client};`; propagado a #45/#46; regressão completa PASS. | resolvido (9c281f9) |
| AUX-20261128-23 | INFO | Ordem sugerida: #47 primeiro (correção de segurança, pequena); depois a pilha atualizada com a integração, resolvendo AUX-20261128-22. | Principal decide a ordem. | resolvido (#47 integrado em cfe918d) |

## Para o próximo agente
- Depois de resolver o conflito, rodar `qa-mazzopay-isolated`, `qa-checkout-isolated` e `qa-supplier-orders-isolated`. Os três dependem de `walletApi.client`.
