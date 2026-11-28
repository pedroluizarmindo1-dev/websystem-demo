---
id: AUX-20261128-client-i18n
agente: AuxiliarCodeAgent
data: 2026-11-28
pr: (ver PR)
branch: agent/frontend-client-i18n
base_sha: ec45b46
final_sha: (ver PR)
modulo: frontend
depende_de: []
deploy: não publicado
---

# Área do Cliente: tradução en/es do texto gerado por JavaScript

## O que mudou
- `public/site-experience.js`: novo bloco que substitui a chamada única `translate(document.body)` quando o idioma é en ou es.
  - **~90 frases novas** por idioma: mensagens de login e cadastro, erros, filtros, rótulos de formulário, avisos.
  - **Textos compostos**: `a · b` traduz cada parte; `Rótulo: valor` traduz o rótulo e o valor, quando conhecido.
  - **Padrões com número**, por exemplo "Olá, X", "Cliente #N", "Exibindo N de M", "N pedidos", "Aguarde Ns", "Erro N".
  - **Atributos** `placeholder`, `aria-label` e `title`.
  - **`MutationObserver`** para conteúdo renderizado depois do carregamento (listas, erros, status).
- Em **pt-BR nada muda**: o caminho antigo é mantido sem alteração.
- `scripts/qa-client-i18n-ui.mjs` (novo) e um passo no CI depois de "Client area UI".

## Achados
| ID | Severidade | Descrição | Ação / responsável | Estado |
|---|---|---|---|---|
| AUX-20261128-26 | AVISO | Mensagens geradas pelo JS da Área do Cliente ficavam só em pt-BR. | Resolvido por este PR. | resolvido (este PR) |
| AUX-20261128-27 | ERRO | Dupla tradução em es: um texto já traduzido pode coincidir com outra chave pt ("Pagamento" vira "Pago", que é chave de status). | Corrigido: uma passada única no carregamento e o observer ignora o que o próprio script escreveu (`WeakMap`). | resolvido |
| AUX-20261128-28 | ERRO | "Olá, Nome · Cliente #1" ficava parcialmente em pt: o padrão "Olá, …" capturava a frase inteira antes da divisão por ` · `. | Corrigido: divide em ` · ` antes de aplicar os padrões. | resolvido |
| AUX-20261128-29 | INFO | `<option>` sem atributo `value` não é traduzido, porque o texto vira o valor enviado. Com `value`, é traduzido. | Ao criar selects, sempre definir `value`. | aceito |
| AUX-20261128-30 | INFO | Ficam em pt, de propósito: dados cadastrados (nomes e categorias de serviço), o nome do idioma "Português", mensagens de erro vindas da API e o texto pré-preenchido do WhatsApp para o suporte. | Traduzir mensagens da API exige tarefa no backend. | aceito |
| AUX-20261128-31 | INFO | Plural: "1 orders" e "1 pedidos" refletem o texto original em pt ("1 pedidos"). | Corrigir na origem (`cliente.js`) numa tarefa futura. | aberto |
| AUX-20261128-32 | AVISO | Ao adicionar texto novo na Área do Cliente, inclua a tradução em `more.en` e `more.es`. O teste falha só para frases já conhecidas; o relatório "report-only" lista suspeitas. | Todos os agentes. | aceito |

## Testes
- `qa-client-i18n-ui` — PASS (BOX), na integração `ec45b46` e na combinação integração + #43/#45/#46 + #47:
  - em en e es, nenhuma frase pt conhecida em login, painel, pedidos, catálogo, formulário, carteira, suporte e perfil;
  - pt-BR intacto;
  - sem erros de JS.
- Regressão na combinação — PASS: `qa-client-area-ui`, `qa-home-ui`, `qa-public-pages`, `qa-layout-audit`, `qa-mazzopay-isolated`, `qa-checkout-isolated`, `qa-supplier-orders-isolated`, `qa-admin-ops-ui`, `qa-seo-isolated`.

## Para o próximo agente
- O merge com a pilha #43 → #45 → #46 e com o #47 é automático, sem conflito (verificado com `git merge-tree`). O bloco fica depois das linhas de dicionário que a pilha altera.
