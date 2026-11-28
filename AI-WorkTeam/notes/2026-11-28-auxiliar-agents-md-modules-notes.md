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
| AUX-20261128-17 | ERRO | O deploy obsoleto 46114045207 ainda aguarda aprovação. A tentativa de cancelar pelo AuxiliarCodeAgent foi negada pela permissão da sessão. | Dono ou principal: cancelar em Actions → execução → "Cancel workflow". **Não aprovar.** | aberto |

## Para o próximo agente
- `AGENTS.md` é arquivo compartilhado: nenhum outro PR aberto o altera (conferido em 28/11).
