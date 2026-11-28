---
id: <PREFIXO>-<AAAAMMDD>-<assunto>
agente: <AuxiliarCodeAgent | Principal | ...>
data: AAAA-MM-DD
pr: <número ou ->
branch: <branch>
base_sha: <SHA da integração usado como base>
final_sha: <SHA final>
modulo: <auth | orders | supplier | payments | frontend | infrastructure | security | docs>
depende_de: [<PRs ou IDs>]
deploy: não publicado
---

# <Título curto>

## O que mudou
- <arquivos e comportamento, em poucas linhas>

## Achados
| ID | Severidade | Descrição | Ação / responsável | Estado |
|---|---|---|---|---|
| <PREFIXO>-<AAAAMMDD>-1 | ERRO/AVISO/INFO | <o quê e onde> | <o que fazer, quem> | aberto |

## Testes
- <comando> — PASS/FAIL (onde rodou)

## Para o próximo agente
- <o que não pode ser esquecido; ordem de merge; flags; armadilhas>
