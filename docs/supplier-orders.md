# Envio supervisionado de pedidos ao fornecedor (IMEIve / DHRU Fusion)

Módulo: `api/supplier-orders.mjs`. Tela: painel admin → Operações → **Fornecedor**. Teste: `scripts/qa-supplier-orders-isolated.mjs` (simulador DHRU, sem pedidos reais).

## Regra principal
Nenhum pedido é enviado automaticamente. Um administrador revisa cada pedido pago com saldo (serviço, ID no fornecedor, custo, identificador e campos) e confirma o envio. O envio exige o número do pedido no corpo (`confirm_order_id`), sessão admin, IP permitido e Origin.

## Estados do envio (`supplier_submissions`, um por pedido)
| Estado | Significado | Próximo passo |
|---|---|---|
| `enviando` | requisição em curso | após 5 min sem resposta vira `incerto` |
| `enviado` | fornecedor aceitou (`REFERENCEID`) | pedido → `em_processamento`; sincronização a cada 10 min ou "Atualizar status" |
| `concluido` | `STATUS 4` | pedido → `concluido`; o cliente vê o resultado (`CODE`) em "Ver resultado" |
| `rejeitado` | `STATUS 3` | pedido → `rejeitado`; o valor volta para a carteira uma vez |
| `falhou` | fornecedor respondeu `ERROR` (nada foi criado) | corrigir e aprovar de novo |
| `incerto` | sem resposta, conexão caiu, resposta ilegível ou sucesso sem `REFERENCEID` | **nunca é repetido automaticamente**: conferir no painel do fornecedor e marcar "Consta no fornecedor" (com o REFERENCEID) ou "Não consta" |

Todas as ações ficam em `supplier_submission_events` e em `audit_logs`.

## Formato DHRU usado
`POST username, apiaccesskey, requestformat=JSON, action, parameters=base64(JSON)`.
- `placeimeiorder`: `{ID, IMEI, CUSTOMFIELD/customfield = base64(JSON dos demais campos), QNT=1 se o serviço for por quantidade}` → `SUCCESS[0].REFERENCEID`.
- `getimeiorder`: `{ID: REFERENCEID}` → `STATUS` 0 novo, 1 em processamento, 3 rejeitado, 4 concluído; `CODE` = resultado.
O endpoint de produção é fixo (`https://imeiveserver.com/api/index.php`); um simulador local só é aceito com `NODE_ENV=test`.

## Ativação
1. Confirmar com o IMEIve o formato de `placeimeiorder` (campos de `CUSTOMFIELD` e serial Apple) para os serviços que serão vendidos.
2. Ter saldo no fornecedor e as credenciais já usadas no catálogo (`IMEIVE_API_URL`, `IMEIVE_API_USERNAME`, `IMEIVE_API_KEY`).
3. `.env` do host: `SUPPLIER_ORDERS_ENABLED=true`; deploy pelo workflow aprovado.
4. Teste real controlado: 1 pedido barato de uma conta da equipe → aprovar → conferir `REFERENCEID` no painel do fornecedor → "Atualizar status" até concluir → conferir o resultado na Área do Cliente.
5. Rollback sem código: `SUPPLIER_ORDERS_ENABLED=false` (a fila continua visível; o envio fica bloqueado).
