---
id: AUX-20261128-deploy-review
agente: AuxiliarCodeAgent
data: 2026-11-28
pr: 46
branch: agent/orders-supplier-supervised
base_sha: b9b516a
final_sha: faf39ad
modulo: infrastructure
depende_de: [43, 45, 46]
deploy: não publicado
---

# Revisão de prontidão para deploy da pilha #43 → #45 → #46

Revisão publicada como comentário no #46. Não é aprovação: o código é do AuxiliarCodeAgent.

## O que foi verificado
- As três branches foram atualizadas com a integração `b9b516a` (#44) por merge normal, sem conflitos e sem force-push. CI verde.
- Ensaio de migração:
  - Uma base criada pelo código de produção (`b5eb4bd`) foi aberta pela pilha.
  - 7 tabelas novas, nenhuma linha perdida; `integrity_check` e `foreign_key_check` ok.
  - O restart é idempotente.
  - **O rollback para `b5eb4bd` sobre a base migrada funciona** (boot, login, listagens).
- `qa-production-release-gates`, `qa-order-transitions`, `bash -n` nos scripts de deploy e `rollback-rehearsal` — PASS.
- PIX e fornecedor sobem desligados. O deploy preserva o `.env` e o `compose.override.yaml` do host.

## Achados
| ID | Severidade | Descrição | Ação / responsável | Estado |
|---|---|---|---|---|
| AUX-20261128-17 | ERRO | A execução 46114045207 (deploy de `8516268`) aguarda aprovação do ambiente `production` desde 28/11 05:52Z e **não tem** o guard de host do #44. Aprová-la publicaria um SHA obsoleto. | Principal ou dono: cancelar e despachar uma execução nova no SHA final da integração. | resolvido (46114045207 failure) |
| AUX-20261128-18 | AVISO | O último preflight manual (46113555580) falhou por timeout SSH antes do script. Não há backup confirmado nessa tentativa. | Rodar o preflight de novo e confirmar backup e restore verificados antes do deploy. | resolvido (preflight 46162600307 success) |
| AUX-20261128-19 | INFO | No ensaio, o restart altera só linhas de runtime (`exchange_rates`, `client_sessions`, `client_security_events`). Isso é esperado. | — | aceito |
| AUX-20261128-20 | INFO | Este ambiente local não tem rede nem `node_modules`. Os testes rodaram no BOX, com a árvore idêntica (sha256 dos 121 arquivos). | — | aceito |

## Para o próximo agente
- Depois do deploy, conferir `/api/health` → `commit` igual ao SHA despachado e `version` 3.0.0-rc1.
- Só então seguir os checklists de ativação (`docs/mazzopay-pix.md`, `docs/supplier-orders.md`).
