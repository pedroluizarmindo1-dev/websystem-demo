# Recarga automática por PIX (MazzoPay)

Módulo: `api/mazzopay.mjs`. Tela: Área do Cliente → Carteira → "Recarregar com PIX". Teste: `scripts/qa-mazzopay-isolated.mjs` (simulador local, sem dinheiro real).

## Como funciona
1. O cliente informa o valor (R$ 10 a R$ 1.000 por padrão) e recebe QR Code + PIX copia e cola.
2. O servidor cria a cobrança em `POST /v1/cobrancas` com `Idempotency-Key` e `referencia` = `ut-dep-<id do depósito>`. A chave da API fica só no servidor.
3. Cada cobrança gera um registro em `wallet_deposits` (`method=pix_manual`, `reference=mazzopay:ut-dep-<id>`). O crédito usa o `wallet_ledger`, que tem `UNIQUE(deposit_id)`: **um crédito por cobrança, no máximo**.
4. O saldo só é creditado quando a MazzoPay informa `status=paga` **e** o valor confere. Três caminhos levam à confirmação:
   - **webhook** assinado (`POST /api/webhooks/mazzopay`, HMAC-SHA256 com `t=…,v1=…`, tolerância de 300 s, `id` do evento deduplicado), sempre reconfirmado com `GET /v1/cobrancas/{id}`;
   - **consulta da tela** do cliente (a cada 4 s; o servidor consulta a MazzoPay no máximo a cada 10 s por cobrança);
   - **reconciliação** a cada 5 min (`GET /v1/eventos` a partir do cursor salvo + recheque das pendentes), também disponível em `POST /api/admin/wallet/pix/reconcile`.
5. Expirada, cancelada ou com falha: o depósito vira `rejected`. Valor divergente ou devolução depois do crédito: a cobrança fica marcada em `attention`, para análise do administrador. O saldo nunca é debitado automaticamente.
6. A revisão manual de depósitos (`/api/admin/wallet/deposits/:id/review`) recusa recargas automáticas: só o provedor liquida.

## Variáveis de ambiente (host / `compose.yaml`)
| Variável | Padrão | Uso |
|---|---|---|
| `MAZZOPAY_ENABLED` | `false` | Liga a recarga automática |
| `MAZZOPAY_API_KEY` | — | Chave `mzk_live_…` com `cobrancas:ler` e `cobrancas:criar` (**sem** `saques:*`) |
| `MAZZOPAY_WEBHOOK_SECRET` | — | Segredo `whsec_…` do webhook. Sem ele, o webhook responde 503 e o crédito acontece pela consulta da tela ou pela reconciliação |
| `MAZZOPAY_MIN_CENTS` / `MAZZOPAY_MAX_CENTS` | `1000` / `100000` | Limites por recarga (iguais ao plano atual: R$ 10 a R$ 1.000) |
| `MAZZOPAY_EXPIRES_MINUTES` | `30` | Validade do código (5–120) |
| `MAZZOPAY_MAX_PENDING_PER_CLIENT` | `3` | Recargas pendentes simultâneas por cliente |
| `MAZZOPAY_RECONCILE_MS` | `300000` | Intervalo da reconciliação (mínimo 60000) |

Nunca coloque a chave ou o segredo no repositório, em issues ou em logs.

## Checklist de ativação em produção
1. Gerar uma **chave nova** no painel MazzoPay (a chave usada no desenvolvimento foi compartilhada em conversa) e revogar a anterior.
2. Cadastrar o webhook `https://unlockertools.tech/api/webhooks/mazzopay` no painel (exige 2FA) e copiar o segredo `whsec_…`.
3. No `.env` do host de produção (fora do repositório): `MAZZOPAY_ENABLED=true`, `MAZZOPAY_API_KEY=…`, `MAZZOPAY_WEBHOOK_SECRET=…`.
4. Fazer o deploy pelo workflow aprovado (backup do SQLite antes).
5. Conferir `GET /api/admin/wallet/pix/status`: `enabled=true`, `webhook_secret_configured=true` e a conta com `cobrancas:criar`.
6. No painel MazzoPay, enviar o "teste.ping": a resposta deve ser 200.
7. Teste real controlado: uma recarga de **R$ 10,00** com uma conta de cliente da equipe, paga pelo app do banco. Conferir o crédito único no extrato e o registro em `/api/admin/wallet/pix/charges`.
8. Rollback sem código: `MAZZOPAY_ENABLED=false` (a tela some; cobranças já criadas continuam sendo reconciliadas quando o módulo voltar).

## Fora do escopo
Saques, estornos automáticos, divisão de taxas e uso do saldo em pedidos (o débito na carteira depende da conversão rascunho → pedido).
