# Pagamento de pedidos com o saldo da carteira

Módulo: `api/checkout.mjs`. Tela: Área do Cliente → Novo pedido → Rascunhos → "Pagar com saldo". Teste: `scripts/qa-checkout-isolated.mjs` (dados fictícios).

## Fluxo
1. O cliente cria o rascunho pelo catálogo (o rascunho passa a guardar `service_id`).
2. `GET /api/client/checkout/drafts` devolve cada rascunho com o preço calculado no servidor (`pricing.mjs` + último câmbio USD/BRL), o saldo e se pode ser pago.
3. `POST /api/client/checkout/drafts/:id` (com `Idempotency-Key` e `expected_amount_cents`) faz, numa única transação:
   recalcula o preço (409 `PRICE_CHANGED` se mudou), confere o saldo (402 `INSUFFICIENT_BALANCE`), debita `wallet_accounts`
   (nunca abaixo de zero), cria o pedido `pendente` / pagamento `pago` com serviço, preço e identificador, vincula ao cliente,
   grava histórico de status e auditoria, registra a cobrança em `wallet_order_charges` e marca o rascunho como convertido
   (`client_checkouts`, `UNIQUE(draft_id)`).
4. Repetições (mesma chave, chave nova ou cliques simultâneos) devolvem o mesmo pedido, sem segundo débito.
5. O pedido é processado pela equipe (não há envio automático ao fornecedor nesta etapa).
6. Quando o admin muda o pedido para **rejeitado** ou **reembolsado**, o valor volta para a carteira uma única vez e o pagamento fica `reembolsado`.
7. O extrato do cliente mostra recargas, pagamentos de pedidos e estornos.

## Rotas
| Rota | Acesso | Uso |
|---|---|---|
| `GET /api/client/checkout/drafts` | cliente | rascunhos com preço e estado |
| `POST /api/client/checkout/drafts/:id` | cliente (Origin) | pagar com saldo |
| `DELETE /api/client/checkout/drafts/:id` | cliente (Origin) | excluir rascunho não convertido |
| `GET /api/admin/checkout/orders/:id` | admin (IP Gate) | identificador e campos do fornecedor para processar o pedido |

## Limites desta etapa
- Só serviços do catálogo do fornecedor (IMEIve) com preço publicado podem ser pagos; os demais continuam "preço sob consulta".
- Rascunhos antigos, sem `service_id`, precisam ser recriados pelo catálogo.
- Envio automático ao fornecedor (com idempotência, retries e reconciliação) fica para a próxima etapa.
