---
id: AUX-20261128-pr43
agente: AuxiliarCodeAgent
data: 2026-11-28
pr: 43
branch: agent/payments-mazzopay-pix
base_sha: b9b516a
final_sha: d274ae1
modulo: payments
depende_de: []
deploy: não publicado
---

# Recarga automática da carteira por PIX (MazzoPay) + SEO básico

## O que mudou
- `api/mazzopay.mjs`:
  - Cria cobranças com `Idempotency-Key` e `referencia`.
  - Webhook verificado por HMAC (`Mazzo-Assinatura`, tolerância de 300 s, dedupe por id do evento) e confirmado por `GET` na API antes de creditar.
  - Reconciliação a cada 5 min (`GET /eventos`, cursor `depoisDe`).
  - Só credita com status `paga` e valor igual; um crédito por cobrança (`wallet_ledger.deposit_id` UNIQUE).
- Rotas do cliente: `/api/client/wallet/pix/*`. Rotas admin: `/api/admin/wallet/pix/*`.
- Webhook em `/api/webhooks/mazzopay`, montado **antes** de `express.json` e da checagem de Origin (precisa do corpo bruto).
- `api/wallet.mjs`: exporta o middleware `client`; a revisão manual bloqueia depósitos `mazzopay:`.
- `robots.txt`, `sitemap.xml`, `favicon.ico` e redirect 301 de `www.` para `APP_ORIGIN` em `api/server.mjs`.
- Interface: painel PIX em `public/cliente.html` e `public/cliente.js`.
- Documentação em `docs/mazzopay-pix.md`.

## Achados
| ID | Severidade | Descrição | Ação / responsável | Estado |
|---|---|---|---|---|
| AUX-20261128-1 | AVISO | A chave live da MazzoPay foi colada em conversa com agente. Tratar como comprometida. | Dono da conta: gerar chave nova, revogar a antiga e guardar só no `.env` do host (`MAZZOPAY_API_KEY`). | aberto |
| AUX-20261128-2 | AVISO | A MazzoPay não tem sandbox, então os testes usam mock local. O primeiro teste real é uma recarga de R$ 10 feita pela equipe. | Seguir o checklist de `docs/mazzopay-pix.md` após o deploy. | aberto |
| AUX-20261128-3 | AVISO | Estorno ou devolução de PIX **depois** do crédito: só é sinalizado ao admin; o débito não é automático. | Tarefa futura (módulo de pagamentos). | aberto |
| AUX-20261128-21 | AVISO | O `AGENTS.md` ainda lista "PIX payment webhooks" como módulo **adiado**. Este PR o implementa por pedido explícito do dono do projeto em 28/11 ("Integre tudo que falta… API PIX"). O PR sobe desligado (`MAZZOPAY_ENABLED=false`). | Dono ou principal: atualizar a seção de módulos adiados do `AGENTS.md`, que é arquivo compartilhado e não foi editado aqui. | aberto |
| AUX-20261128-4 | ERRO | O webhook `paga` podia chegar antes de a API refletir o pagamento, e o evento era descartado. | Corrigido: responde 503 para o provedor reenviar. | resolvido (576b173) |
| AUX-20261128-5 | ERRO | Cobranças presas em `criando` contavam para o limite de pendentes para sempre. Havia também corrida entre duas criações com a mesma chave. | Corrigido: `criando` só conta por 30 min; a corrida devolve a cobrança existente. | resolvido (576b173) |
| AUX-20261128-6 | INFO | No teste, outro cliente com cobrança do mesmo valor era pago por engano. | O teste agora localiza a cobrança por `referencia`. | resolvido |
| AUX-20261128-7 | INFO | O auditor de layout acusava como quebrada a `<img>` do QR sem `src`. | O auditor ignora `img` sem `src`, e o QR usa o atributo `hidden`. | resolvido |

## Testes
- `qa-mazzopay-isolated`, `qa-seo-isolated`, `qa-security-isolated` e os gates do AGENTS.md — PASS (BOX e CI).

## Para o próximo agente
- O PIX sobe **desligado** (`MAZZOPAY_ENABLED=false`). Ativar exige `MAZZOPAY_API_KEY` e `MAZZOPAY_WEBHOOK_SECRET` (`whsec_…`) no host.
- Limites da conta (consulta só de leitura em 28/11): R$ 10–1.000 por cobrança; R$ 20 mil por dia; taxa de R$ 0,50.
- O Nginx precisa repassar `/api/webhooks/mazzopay` sem alterar o corpo da requisição.
