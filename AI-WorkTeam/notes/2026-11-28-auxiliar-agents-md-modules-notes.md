---
id: AUX-20261128-agents-md
agente: AuxiliarCodeAgent
data: 2026-11-28
pr: 50
branch: agent/docs-agents-deferred-modules
base_sha: ec45b46
final_sha: (ver PR)
modulo: docs
depende_de: []
deploy: não publicado
---

# AGENTS.md: módulos autorizados e protocolo de notas

## O que mudou
- Saem da lista de "adiados" o PIX automático (#43) e o envio supervisionado ao fornecedor (#46), autorizados pelo dono em 28/11. Os dois sobem desligados e só são ativados pelos checklists em `docs/`.
- Fica registrada no protocolo a regra do envio supervisionado: aprovação por pedido e nenhum reenvio automático de casos incertos.
- Formulários dinâmicos por fornecedor continuam adiados.
- Nova seção "Inter-agent notes" e item no checklist de PR: toda alteração tem nota em `AI-WorkTeam/notes/`.

## Achados
| ID | Severidade | Descrição | Ação / responsável | Estado |
|---|---|---|---|---|
| AUX-20261128-21 | AVISO | O `AGENTS.md` listava webhooks PIX como adiados. | Este PR atualiza o texto. | resolvido (este PR) |
| AUX-20261128-24 | AVISO | As **instruções do Projeto no claude.ai** (cópia do AGENTS usada pelos agentes Claude, seção "7. Deferred modules") também listam PIX automático e webhooks como adiados. Elas não ficam no repositório. | Dono: atualizar o texto nas instruções do Projeto. | aberto |
| AUX-20261128-17 | ERRO | Deploy obsoleto 46114045207 (`8516268`). | Conferido: encerrado com `failure`, nada publicado (resposta do Principal, PRI-20261128-integration-security). | resolvido (46114045207 failure) |
| AUX-20261128-25 | AVISO | A nova execução 46162987126 (`b9b516a`) aguarda aprovação de `production`. Esse SHA não inclui #47, #43, #45 e #46. Aprová-la publica só #41, #42 e #44; depois, outro deploy seria necessário. | Principal ou dono: aprovar só se quiser publicar `b9b516a` agora. Se não, deixar expirar e despachar no candidato final, após 47 → 43 → 45 → 46. | aberto |
| PRI-20261128-1 | AVISO | Regressão específica da carteira para o #47 (`4fdaade`). | AuxiliarCodeAgent: 11/11 PASS (teto R$ 1.000, 4ª pendente 429, rajada concorrente aceita 3, referência duplicada 409 com rollback, cookies). #47 aprovado. | resolvido (review APPROVED no #47) |
| AUX-20261128-22 | AVISO | `return {client};` em `mountWallet`. | Ensaio: #47 + pilha com o conflito resolvido; mazzopay, checkout, fornecedor, security, client e release gates PASS. Aplicar a mesma resolução ao atualizar o #43 após o merge do #47. | resolvido (9c281f9) |

## Para o próximo agente
- `AGENTS.md` é arquivo compartilhado: nenhum outro PR aberto o altera (conferido em 28/11).
