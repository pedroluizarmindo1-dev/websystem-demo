---
id: AUX-20261128-pr45
agente: AuxiliarCodeAgent
data: 2026-11-28
pr: 45
branch: agent/orders-wallet-checkout
base_sha: b9b516a
final_sha: a339033
modulo: orders
depende_de: [43]
deploy: não publicado
---

# Pagar rascunhos de pedido com o saldo da carteira

## O que mudou
- `api/checkout.mjs` cria as rotas:
  - `GET/POST/DELETE /api/client/checkout/drafts[/:id]`
  - `GET /api/admin/checkout/orders/:id`
- O preço é recalculado no servidor (`priceService`). O valor enviado pelo cliente é ignorado.
- Uma única transação `BEGIN IMMEDIATE` faz tudo junto:
  - débito na carteira;
  - criação do pedido `pendente`/`pago`;
  - vínculo com o cliente;
  - histórico com origem `client_checkout`;
  - auditoria;
  - registros em `wallet_order_charges` e `client_checkouts`.
- `PATCH /api/orders/:id` com `rejeitado` ou `reembolsado` estorna o saldo **uma vez** (`refundOrderCharge`, dentro da mesma transação) e devolve `wallet_refund_cents`.
- O extrato da carteira mostra pagamentos e estornos de pedidos.
- Os rascunhos guardam `service_id` (ALTER aditivo).
- Interface: botão "Pagar com saldo" na Área do Cliente.

## Achados
| ID | Severidade | Descrição | Ação / responsável | Estado |
|---|---|---|---|---|
| AUX-20261128-8 | ERRO | `Cannot access 'audit' before initialization`: `audit` é definido depois do `mount` em `server.mjs`. | Corrigido: wrapper preguiçoso `(...args)=>audit(...args)`. Não mover a montagem sem manter o wrapper. | resolvido |
| AUX-20261128-9 | INFO | Teste instável (diferença de 2 centavos): o servidor busca a cotação USD/BRL real ao iniciar e muda o preço no meio do teste. | O teste espera `/api/exchange-rates` e grava a cotação de QA como a mais recente. Vale para qualquer teste com preço. | resolvido |
| AUX-20261128-10 | INFO | Puppeteer: "Node is either not clickable" porque a re-renderização substitui o nó. | Usar `waitForNetworkIdle` e depois `$eval(el=>el.click())`. | resolvido |
| AUX-20261128-11 | AVISO | Está empilhado sobre o #43. O merge fora de ordem traz o #43 junto. | Merge na ordem #43 → #45 → #46. | aberto |

## Testes
- `qa-checkout-isolated` (corrida de duplo clique, saldo insuficiente, estorno único, acesso cruzado entre clientes) e os gates do AGENTS.md — PASS.

## Para o próximo agente
- Nenhum status novo de pedido foi criado; vale a máquina de estados de `api/order-transitions.mjs`.
- O saldo nunca fica negativo: há `CHECK balance_cents>=0` em `wallet_accounts`.
