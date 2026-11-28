# AI-WorkTeam — notas entre agentes

Diretório de comunicação entre os agentes que trabalham neste repositório (agente principal, AuxiliarCodeAgent e outros).
Cada alteração relevante ganha uma **nota** que registra o que foi feito, **erros**, **avisos** e o que o próximo agente precisa saber.
As notas complementam o PR, sem substituí-lo: o PR continua sendo a fonte de verdade da revisão e do CI.

## Regras
1. **Uma nota por alteração** (PR, revisão, incidente ou investigação), criada no mesmo PR da alteração sempre que possível.
2. Nome do arquivo: `notes/AAAA-MM-DD-<agente>-<assunto>.md` (ex.: `2026-11-28-auxiliar-pr46-supplier-supervised.md`).
   Não existe índice central: a listagem ordenada de `notes/` é o índice, para não haver conflito entre agentes.
3. Use o modelo [`TEMPLATE.md`](TEMPLATE.md). O cabeçalho YAML é obrigatório; ele permite filtrar notas por script.
4. Cada achado é uma linha com severidade e ID estável:
   - `ERRO` — algo quebrou ou quebraria (teste, build, dado, segurança). Precisa de correção ou decisão.
   - `AVISO` — risco, limitação ou pré-condição. Não bloqueia sozinho, mas não pode ser esquecido.
   - `INFO` — contexto útil (decisão tomada, causa de um teste instável, convenção).
   IDs: `<PREFIXO>-<AAAAMMDD>-<n>` (ex.: `AUX-20261128-3`). O prefixo do agente principal é `PRI`.
5. Estado de cada achado: `aberto`, `resolvido (<SHA ou PR>)` ou `aceito (<quem decidiu>)`.
   Para responder, outro agente edita só a linha do achado (estado mais a resposta) ou cria uma nota nova que cite o ID.
   **Nunca apague** achados de outro agente.
6. **Proibido** nas notas: tokens, chaves, senhas, `.env`, dados de clientes (e-mail, IMEI real, CPF) e saídas brutas de logs de produção.
   Cite o nome da variável (`MAZZOPAY_API_KEY`), nunca o valor.
7. **Nunca** declare algo publicado em produção sem evidência: execução do workflow aprovado e `/api/health` com o commit esperado.
   Use `deploy: não publicado | publicado (<run id>, <SHA>)`.

## Como ler rapidamente
```bash
# achados em aberto, de todas as notas
grep -rn "| aberto" AI-WorkTeam/notes/
# notas de um PR
grep -ln "^pr: 46" AI-WorkTeam/notes/*.md
```
