---
id: AUX-20261128-pr46
agente: AuxiliarCodeAgent
data: 2026-11-28
pr: 46
branch: agent/orders-supplier-supervised
base_sha: b9b516a
final_sha: faf39ad
modulo: supplier
depende_de: [43, 45]
deploy: não publicado
---

# Envio de pedidos ao fornecedor (IMEIve/DHRU) sob aprovação do admin

## O que mudou
- `api/supplier-orders.mjs`, com interface na aba **Operações → Fornecedor** (`src/admin-ops.jsx`).
- Nada é enviado sem aprovação: o admin clica em "Revisar e enviar" e depois em "Confirmar envio", e a API exige `confirm_order_id`.
- Cada pedido tem um registro em `supplier_submissions`. Estados:

  | Estado | Significado |
  |---|---|
  | `enviando` | requisição em andamento |
  | `enviado` | fornecedor aceitou |
  | `concluido` | serviço finalizado |
  | `rejeitado` | fornecedor rejeitou |
  | `falhou` | fornecedor respondeu `ERROR` |
  | `incerto` | resultado desconhecido |

- A sincronização roda a cada 10 min ou pelo botão "Atualizar status". Ela move o pedido pela máquina de estados; com `STATUS 3` estorna a carteira uma vez.
- O cliente vê o resultado (`CODE`) em "Ver resultado" (`/api/client/checkout/orders/:id/result`).
- `SUPPLIER_ORDERS_ENABLED=false` por padrão (`compose.yaml`).

## Achados
| ID | Severidade | Descrição | Ação / responsável | Estado |
|---|---|---|---|---|
| AUX-20261128-12 | AVISO | O formato de `placeimeiorder` (campos em `CUSTOMFIELD`, serial Apple) foi feito pela documentação DHRU v6.1, sem pedido real. | Confirmar com o IMEIve e fazer 1 pedido real controlado antes de ligar a flag. | aberto |
| AUX-20261128-13 | AVISO | Um envio `incerto` (conexão caiu, resposta ilegível ou `enviando` parado há mais de 5 min) **nunca** é repetido automaticamente, por design: repetir pode duplicar o pedido no fornecedor. | O admin confere no painel do fornecedor e marca "Consta", com o REFERENCEID, ou "Não consta". Não "corrigir" isso com retry automático. | aceito (regra do usuário: envio supervisionado) |
| AUX-20261128-14 | AVISO | O endpoint de produção é fixo (`https://imeiveserver.com/api/index.php`). Se `IMEIVE_API_URL` no host for diferente, o módulo fica "não configurado". O catálogo atual já exige o mesmo valor. | Nenhuma, se o catálogo funciona. Diagnóstico: `/api/admin/supplier/status` → `configured`. | aceito |
| AUX-20261128-15 | INFO | O simulador DHRU (`127.0.0.1`) só é aceito com `NODE_ENV=test`. | Não relaxar essa regra em produção. | aceito |
| AUX-20261128-16 | AVISO | Está empilhado sobre o #45 e o #43. | Merge na ordem #43 → #45 → #46. | aberto |

## Testes
- `qa-supplier-orders-isolated` (simulador DHRU, **sem pedidos reais**) — PASS. Cobre:
  - aprovação obrigatória;
  - envio único, inclusive com cliques concorrentes;
  - recusa seguida de reaprovação;
  - estado `incerto` sem nova tentativa;
  - resolução manual;
  - sincronização com código e estorno;
  - resultado visível só para o dono;
  - auditoria;
  - ausência de segredos e IMEIs nos logs;
  - aba admin no navegador.
- Gates do AGENTS.md — PASS.

## Para o próximo agente
- Checklist de ativação: `docs/supplier-orders.md`. Rollback sem código: `SUPPLIER_ORDERS_ENABLED=false`.
