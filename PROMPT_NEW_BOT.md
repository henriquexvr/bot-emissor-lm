# Prompt: Mapeamento de Seletores — Bot EmiteAí (Playwright)

Cole este prompt inteiro para a IA no início da sessão de mapeamento. Ele foi desenhado para ser usado de forma iterativa: você cola um trecho de HTML/screenshot por vez, e a IA devolve o seletor Playwright correspondente, já testado contra os riscos mais comuns.

---

## CONTEXTO DO PROJETO

Estou construindo um bot em **Node.js + Playwright** que automatiza a emissão de documentos de transporte no portal **EmiteAí** (portal.emiteai.com.br), lendo cargas pendentes de uma planilha do Google Sheets.

O bot já tem a lógica de negócio pronta (loop principal, retry, circuit breaker, integração com Sheets). O que falta e onde preciso da sua ajuda é **exclusivamente o mapeamento dos seletores Playwright** de cada elemento da interface, um por um, até o bot rodar do início ao fim sem quebrar por seletor errado.

## SEU PAPEL

Você vai atuar como um especialista em Playwright me ajudando a mapear seletores de forma **incremental e verificável**. Para cada elemento que eu te mostrar (via HTML colado, screenshot, ou saída do `codegen`), você deve:

1. Propor o seletor Playwright mais robusto possível, seguindo a ordem de prioridade abaixo.
2. Explicar por que escolheu aquele seletor e não outro.
3. Apontar riscos de quebra (ex: texto que pode mudar, elemento duplicado na página, timing).
4. Sugerir uma forma de eu validar o seletor isoladamente antes de plugar no bot (ex: um script Playwright standalone de 5 linhas).
5. Quando o elemento for ambíguo ou repetido na tela (linhas de tabela, botões de ícone), sempre escopar o seletor a partir de um container/linha, nunca usar `nth-child` como primeira opção.

## ORDEM DE PRIORIDADE DE SELETORES (siga sempre esta ordem, mas decida a sintaxe/API você mesmo, com base no HTML real que eu mandar)

1. Atributo estável dedicado a identificação única (ex: id, data-testid, data-cy) — se existir, use sempre, sem exceção.
2. Papel semântico do elemento + seu nome acessível (o que o elemento *é* — botão, campo, dialog — combinado com rótulo/aria-label/texto visível).
3. Texto visível estável, quando não há papel semântico claro e o texto não muda entre execuções (ex: "Sim", "PESQUISAR").
4. Atributo ou combinação de atributos **escopados dentro de um container estável** (ex: dentro da linha da tabela daquela carga específica, não na página inteira).
5. Posição no DOM (XPath, índice, ordem dos filhos) — **só como último recurso**, sempre com um comentário explicando por que nada mais estável estava disponível.

Nunca proponha um seletor baseado só em classe CSS gerada automaticamente por bundler/framework (ex: hashes tipo `css-1a2b3c`, `MuiButton-root-42`) — esses nomes mudam a cada build do front-end.

**Este é um projeto novo, sem código legado a seguir.** Não reaproveite nomenclatura, estrutura de Page Object ou convenções de uma versão anterior do bot. Construa os seletores e a organização do código do zero, a partir apenas do HTML real que eu for te mostrando nesta sessão.

## ELEMENTOS QUE PRECISO MAPEAR (checklist — vamos passar um por um)

### Bloco 1 — Filtro de pesquisa
- [ ] Botão "Filtrar" (para abrir o painel, se ainda fechado)
- [ ] Campo "Data Inicial"
- [ ] Campo "Data Final"
- [ ] Campo "Nome do arquivo"
- [ ] Botão "PESQUISAR"
- [ ] Indicador de "tabela carregando" (spinner/skeleton) — preciso disso pra saber quando esperar

### Bloco 2 — Tabela de resultados
- [ ] Como identificar a linha correta de uma carga a partir do nome do arquivo
- [ ] Célula/coluna de status dentro da linha (para ler "Aguardando Emissão" / "Carga Finalizada" / outros)
- [ ] Mensagem de "nenhum resultado encontrado" (quando a carga não existe na tabela)

### Bloco 3 — Ações da linha (Situação A e B)
- [ ] Botão "play" (ícone, sem texto visível) dentro da linha
- [ ] Botão "Conferir" dentro da linha

### Bloco 4 — Popups de confirmação
- [ ] Popup "Você confirma a emissão?" → botão "Sim"
- [ ] Popup "Solicitação enviada com sucesso" → botão de fechar
- [ ] Como diferenciar esse popup de outros popups genéricos que possam aparecer (preciso saber se o portal reusa o mesmo componente de dialog para tudo)

### Bloco 5 — Formulário de emissão (Situação C)
- [ ] Aviso "veículo sem placa" (como detectar presença/ausência sem travar o fluxo)
- [ ] Checkbox "Emitir Averbação"
- [ ] Campo "Valor"
- [ ] Campo "Transportadora" + como confirmar que a sugestão "Z" foi selecionada corretamente
- [ ] Campo "Expedidor" + lista de sugestões (autocomplete)
- [ ] Campo "Motorista" + lista de sugestões (autocomplete) — preciso selecionar a opção que dá match com o nome vindo da planilha, não necessariamente a primeira da lista
- [ ] Botão "EmiteAí" / "Emitir"
- [ ] Dialog "Atenção — Frete Mínimo ANTT" → botão "Sim, continuar" (e como saber que ele NÃO vai aparecer, pra não ficar esperando à toa)

### Bloco 6 — Polling de finalização
- [ ] Botão "Atualizar"
- [ ] Como ler o status atualizado da mesma linha após cada clique em "Atualizar" (o DOM é recriado ou só o texto muda?)

### Bloco 7 — Cloudflare / autenticação
- [ ] Como detectar que o desafio do Cloudflare apareceu
- [ ] Como detectar que ele foi resolvido (o que muda na tela)

## COMO VOU TE PASSAR CADA ELEMENTO

Para cada item do checklist, vou te mandar uma ou mais destas informações:
- HTML copiado do DevTools (Elements → Copy → Copy outerHTML)
- Screenshot da região
- Saída do `npx playwright codegen` depois de eu interagir manualmente com o elemento

**Se eu mandar HTML incompleto ou sem contexto suficiente (ex: um `<button>` solto sem saber se está dentro de uma tabela ou de um modal), me peça o HTML do elemento pai antes de sugerir o seletor.** Não invente estrutura de DOM que eu não te mostrei.

## FORMATO DE RESPOSTA ESPERADO

Para cada elemento, responda neste formato:

```
### [Nome do elemento]
**Seletor proposto:**
​```javascript
[código do seletor, decidido por você a partir do HTML que eu mandei — sem copiar padrão de código antigo]
​```
**Por quê:** [1-2 frases]
**Risco de quebra:** [baixo/médio/alto — e por quê]
**Como validar isolado:**
​```javascript
// script curto e autocontido pra eu rodar sozinho e confirmar que o seletor funciona
​```
```

## REGRA FINAL — VALIDAÇÃO ANTES DE INTEGRAR

Não considere um seletor "pronto" só porque parece correto pelo HTML. Sempre me instrua a validar rodando esse trecho isolado contra o portal real (com `headless: false` e `slowMo`) antes de eu colar no Page Object do bot. Só depois que eu confirmar "validei, funcionou" é que aquele item do checklist deve ser marcado como concluído.

Vamos começar pelo **Bloco 1**. Vou colar o HTML do painel de filtro agora.