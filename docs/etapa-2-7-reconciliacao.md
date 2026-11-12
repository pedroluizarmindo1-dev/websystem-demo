# Etapa 2.7 — Reconciliação segura (2026-11-12)

## Diagnóstico confirmado
- `main` -> `feature/order-status-history-2-4`: ahead 4, behind 0.
- `main` -> `release/client-build-2026-11-10`: ahead 165, behind 6; bases divergentes.
- BOX `/workspace/websystem` na branch `release/client-build-2026-11-10`, commit `1b5254e`.
- BOX possui 12 arquivos rastreados modificados e arquivos novos não rastreados. Não executar checkout/reset/merge sobre essa árvore suja.
- A implementação de histórico no PR #3 altera `api/server.mjs`, `api/commerce.mjs`, `api/schema.sql`, `src/main.jsx`.
- A release modifica `api/server.mjs` e `api/commerce.mjs`; a integração requer reconciliação manual desses endpoints e checagem de autorização.
- A release tem Client Area com endpoint de histórico próprio baseado em `audit_logs`. Não assumir equivalência com `order_status_history` do PR #3.

## Verificações executadas no BOX (branch release, não PR #3)
- `node scripts/qa-client-isolated.mjs`: PASS
- `node scripts/qa-rbac-isolated.mjs`: PASS (11 rotas negadas)
- `node scripts/qa-security-isolated.mjs`: PASS

## Sequência segura para integração
1. Preservar alterações locais com snapshot/patch e backups dos SQLite, sem incluir segredos em commits.
2. Preparar worktree isolada da branch release; nunca substituir o diretório de trabalho atual.
3. Portar seletivamente tabela e gravações transacionais, incluindo TODOS os caminhos de criação e atualização de pedidos.
4. Preservar os controles de RBAC, Origin/CSRF e escopo por cliente da release; impedir acesso cruzado a históricos.
5. Integrar timeline na interface efetivamente servida pela release, verificando `public/cliente.js` e `src/main.jsx`.
6. Executar testes de migração, regressão, isolamento e build na worktree integrada.
7. Criar PR de integração separado; nenhum deploy automático antes de validação e backup/rollback.

## Status
Diagnóstico concluído. Integração **não aplicada**; ambiente de produção **inalterado**.
