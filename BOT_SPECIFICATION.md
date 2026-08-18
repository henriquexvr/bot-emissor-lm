# 🤖 EmiteAí Bot v2.2.3 — Especificação Operacional (Execution Specification)

> **⚠️ DOCUMENTO FONTE DA VERDADE**
> Qualquer IA ou desenvolvedor que for alterar o código **deve ler este arquivo completamente** antes de tocar em qualquer módulo. Em caso de conflito entre o que o código faz e o que este documento descreve, o comportamento aqui descrito é o pretendido. Se o código diverge, trata-se de um bug ou este documento exige atualização síncrona.

---

## 1. Objetivo do Sistema
Automatizar de ponta a ponta o processo de emissão de cargas do portal EmiteAí (Shopee), operando sob quatro pilares:
1. **Alta Disponibilidade:** O bot deve continuar operando mesmo sob travamentos de abas ou interferências do Cloudflare.
2. **Recuperação Automática (Self-Healing):** Falhas locais (um clique, um campo) não devem derrubar o worker; falhas de worker não devem derrubar o processo principal.
3. **Paralelismo Seguro:** Múltiplos workers processam cargas concorrentemente sem *race conditions*, sem duplicar processamento e sem perder registros.
4. **Sanitização Proativa:** Dados inconsistentes devem ser ignorados cedo para não desperdiçar processamento[cite: 5].

---

## 2. Princípios Invioláveis
Antes de qualquer submissão de código, respeite obrigatoriamente:

*   **Nunca perder uma carga:** Toda carga lida da planilha deve terminar em um estado final válido (`CARGA_FINALIZADA`, `VEICULO_SEM_PLACA`, `MOTORISTA_NAO_CADASTRADO`, `DADOS_INCOMPLETOS`, `PLACA_REJEITADA` ou erro sistêmico). Nunca descarte uma carga silenciosamente.
*   **Nunca processar uma carga duas vezes:** O controle de filas e o `Set` de "processadas" garantem a idempotência.
*   **Isolamento de Falhas:** A unidade de falha é o worker/aba, não o processo principal. Nunca reinicie o sistema inteiro por erro em uma aba.
*   **Prioridade de Recuperação (Local First):** Toda recuperação deve ocorrer primeiro localmente (retry no mesmo seletor, campo ou etapa). Atualização (`page.reload()`) é estritamente o último recurso.
*   **Externalização de Regras:** Nenhuma variável de ambiente (planilha alvo, status alvo, transportadora) deve ser fixada (*hardcoded*) no código-fonte[cite: 5].
*   **Performance por Design:** Evite `waitForTimeout` fixos. Prefira `waitForSelector`, `getByRole`, e `waitForLoadState('domcontentloaded')`. Timeouts altos (30s) devem ser reduzidos e combinados com fallbacks de seletor.

---

## 3. Arquitetura do Sistema

```text
[.env / config.json] (Configurações externalizadas)
       │
[Google Sheets]
       │ (Ler cargas pendentes + Filtro de Sanitização)
       ▼
[Queue Manager] (Gerencia Fila 1 e Fila 2, cooldown exponencial, controle de batch)
       │
       ▼
[Worker Pool]   (N workers, isolamento de instâncias)
       │
       ▼
[Worker]        (Estado, timers, health, metrics, recovery 100% isolados)
       │
       ▼
[Orchestrator]  (Métodos: executarPreenchimento / executarEmissao)
       │
       ▼
[Playwright]    (Interação de UI, locators semânticos rigorosos)
       │
       ▼
[Portal EmiteAí](React + Material-UI, sujeito a Cloudflare)
```

---

## 4. Configuração e Observabilidade (Novo)

### 4.1. Configurações Externalizadas
O comportamento do bot é definido em um arquivo de configuração (ex: `.env`), permitindo ajustes sem alteração na lógica[cite: 5].
*   `PLANILHA_ID`: ID da planilha fonte.
*   `STATUS_ALVO`: Ex: "EM_PROCESSAMENTO". O bot só processa linhas com este status exato.
*   `TRANSPORTADORA_PADRAO`: Ex: "matriz".
*   `EMITIR_AVERBACAO`: `true` (padrão) mantém marcado o checkbox "Emitir Averbação" no formulário; `false` o desmarca.
*   `MODO_EXECUCAO`: `headless` ou `desenvolvimento` (mantém navegador aberto visualmente)[cite: 5].

### 4.2. Logs Diários em Arquivo
O sistema deve implementar uma biblioteca de logs (ex: `winston`) que espelhe o terminal para arquivos físicos organizados por dia (ex: `logs/emiteai-2026-07-22.log`)[cite: 5]. Isso garante rastreabilidade para falhas ocorridas durante a madrugada.

---

## 5. Inicialização e Sanitização (`src/index.js` → `main()`)
1. **Configuração:** Carrega variáveis do `.env`[cite: 5].
2. **BrowserManager:** Inicia `chromium.launchPersistentContext(profileDir)` reaproveitando sessão.
3. **Navegação Inicial:** `page.goto(URL, { waitUntil: 'domcontentloaded' })`.
4. **Cloudflare Bypass:** `aguardarResolucaoCloudflare(page, 120s)` monitora elementos (`#cf-error-details`, `#turnstile-wrapper`).
5. **Validação de Tabela:** Aguarda DOM base `table, div[role="grid"]` (30s timeout).
6. **Alimentação e Sanitização de Fila (O Filtro de Lixo):** `SheetsRepository` lê colunas A-I buscando o `STATUS_ALVO`.
    *   **Validação Prévia:** O bot ignora automaticamente e registra no log linhas que não tenham o *nome do arquivo*, *CNPJ* ou *valor* preenchido[cite: 5].
    *   Essas linhas recebem imediatamente o status `DADOS_INCOMPLETOS` na planilha e **não** entram na Fila 1[cite: 5].
7. **Worker Pool:** Instancia workers (padrão: 2). Cada um abre filtro, define data e inicia consumo.

---

## 6. O Ciclo de Lotes (Batch Lifecycle) e Loop dos Workers
O sistema não processa as cargas de forma contínua e infinita, mas sim em **Lotes Fechados de 20 cargas**. O ciclo de vida obedece estritamente a esta ordem:

1. **Modo Preenchimento (Fluxo 1):** Os workers puxam cargas da Fila 1 e processam até que o contador do lote atinja 20 cargas.
2. **Bloqueio e Transição:** Ao atingir 20 cargas preparadas (ou se a Fila 1 esvaziar antes disso), a Fila 1 é bloqueada. O sistema altera a flag para `modoEmissao = true`.
3. **Modo Emissão (Fluxo 2):** Os workers agora focam unicamente na Fila 2, acionando o "Play" e fazendo o polling de finalização destas 20 cargas.
4. **Reset do Ciclo:** Somente quando a Fila 2 chega a zero E não há nenhum worker processando emissão, o sistema aciona o `resetBatch()`. A Fila 1 é desbloqueada e o bot recomeça a preparar as próximas 20 cargas.

---

## 7. Fluxo 1 — Preenchimento (`orchestrator.js`)
*Objetivo: Limitar-se a 20 cargas. Localizar, preencher formulário (salvando estados de erro na memória da carga) e mover para Fila 2.*

> **⚠️ REGRA DE ESTADO NA MEMÓRIA:**
> O objeto `carga` transita entre as filas. Se ocorrer um alerta (sem placa, sem motorista), o Fluxo 1 deve injetar as propriedades `carga.veiculoSemPlaca = true` e/ou `carga.motoristaNaoCadastrado = true` neste objeto antes de enviá-lo para a Fila 2.

| Passo | Detalhe da Ação | Locators (Playwright Best Practices) |
| :--- | :--- | :--- |
| **1** | Limpar UI | Pressionar `Escape` (x5). Evaluate para remover modais/backdrops. |
| **2** | Pesquisar Arquivo | `getByPlaceholder('Nome do arquivo')`. Input: `click`, `fill(nome)`. |
| **3** | Ler Status | Isolar a linha (row). Buscar texto do status na coluna. |
| **4** | Decisão de Rota | Se `"Aguardando Emissão"` -> Pula o preenchimento e move direto para Fila 2.<br>Se `"Aguardando Conferência"` -> Segue para o Passo 5 (abre formulário).<br>Se `"Carga Finalizada"` -> Pula e atualiza planilha. |
| **5** | Clicar Conferir | Dentro da linha isolada: `locator('button[title="Conferir"]')`. |
| **6** | Veículo sem placa | Verifica `div` "não cadastrado". Se achar, marca **`carga.veiculoSemPlaca = true`**, fecha o X (`Escape`) e segue. |
| **7** | Preencher Valor | `getByLabel('Valor')`. Type ` delay: 20` + `Tab`. |
| **8** | Configurar Averbação | Localizar `input[type="checkbox"]` de Averbação. `check()` se `EMITIR_AVERBACAO=true` (default), senão `uncheck()`. |
| **9** | Transportadora | `getByLabel('Transportadora*')`. Injeta `TRANSPORTADORA_PADRAO`. |
| **10** | Expedidor | `getByLabel('Expedidor*')`. Aciona autocomplete com CNPJ. |
| **11** | Motorista | `getByLabel('Motoristas')`. Aciona autocomplete. Se não achar match exato, marca **`carga.motoristaNaoCadastrado = true`** e segue. |
| **12** | Clicar EmiteAí | `getByRole('button', { name: 'EmiteAí' })`. `.scrollIntoViewIfNeeded()`. |
| **13** | Tratamento Servidor | Monitora aviso de "Placa Rejeitada" no clique. Se ocorrer, aborta a carga, não envia pra Fila 2 e já marca `PLACA_REJEITADA` na planilha. |
| **14** | Popups Finais | Popups de ANTT e Confirmação. Aciona Tratamento de Valor Mínimo (R$ 1,00) se der erro de valor. |
| **15** | Fechar e Mover | Fecha popup de sucesso via `Escape`. **Envia o objeto `carga` (com suas flags) para a Fila 2.** |

---

## 8. Fluxo 2 — Emissão (`orchestrator.js`)
*Objetivo: Consumir as exatas 20 cargas da Fila 2, efetivar a emissão, escrever o status correto baseado na memória da carga e zerar a fila para reiniciar o lote.*

| Passo | Detalhe da Ação | Locators | Espera |
| :--- | :--- | :--- | :--- |
| **1 a 3**| (Setup Inicial) | Limpeza, pesquisa pelo nome do arquivo e leitura de status (Idem Fluxo 1). | - |
| **4** | Decisão de Rota | Se `"Carga Finalizada"`, segue para o Passo 9.<br>Se `"Aguardando Emissão"`, avança para clicar no Play. | - |
| **5** | Clicar Play | Linha isolada, cadeia de seletores até encontrar:<br>1. `button` dentro da linha que contém `span.material-icons:text-is("start")`<br>2. `span.material-icons:text-is("play_arrow")`<br>3. `span.material-icons:text-is("play")`<br>4. `span.material-icons` (qualquer)<br>5. `svg`<br>6. Fallback: primeiro `button` da linha | `waitFor({ state: 'enabled' })` + 200ms delay |
| **6** | Confirmação | `getByRole('button', { name: /^Sim$/ })`. | 600ms |
| **7** | Fechar Sucesso | Isola `div[role="dialog"]`. Usa `Escape`. | 600ms |
| **6** | Confirmação | `getByRole('button', { name: /^Sim$/ })`. | 600ms |
| **7** | Fechar Sucesso | Isola `div[role="dialog"]`. Usa `Escape`. | 600ms |
| **8** | Escrita Planilha | O bot escreve o status na planilha baseado na memória da `carga` (sem esperar por polling):<br>1. Se `carga.motoristaNaoCadastrado` -> Grava `MOTORISTA_NAO_CADASTRADO`<br>2. Se `carga.veiculoSemPlaca` -> Grava `VEICULO_SEM_PLACA`<br>3. Caso contrário -> Grava `CARGA_FINALIZADA`<br>Após escrever, o worker **já avança para a próxima carga da Fila 2**. | - |

> **Ciclo completo do Fluxo 2:** Para cada carga na Fila 2, o bot pesquisa, clica no Play (seta), confirma o popup "Sim", fecha popup de sucesso e **escreve o status diretamente na planilha** baseado nas flags de memória (`motoristaNaoCadastrado`, `veiculoSemPlaca`). O Play + confirmação já indicam que a emissão foi registrada com sucesso, então não há necessidade de polling de finalização. O worker avança imediatamente para a próxima carga da Fila 2.

---

## 9. GUIA DE SELETORES CRÍTICOS (A Lei do Playwright)
A análise técnica proíbe o uso de seletores posicionais (`nth-of-type`) e de estilização dinâmica (`.jss`, `.Mui-xxx`).

| Elemento | Prática PROIBIDA 🚫 | Prática OBRIGATÓRIA ✅ |
| :--- | :--- | :--- |
| **Botão "Sim"** | `div.MuiDialogActions-root-558 span` | `page.getByRole('button', { name: /^Sim$/ })` |
| **Inputs Autocomplete** | `#material-autocomplete-334` | `page.getByLabel('Transportadora*')` |
| **Botão Fechar Sucesso** | `div.jss41 > img` | `dialog.locator('img').first()` ou `Escape` |
| **Ações na Tabela** | `td:nth-of-type(12) button` | Localizar *Row* por texto, e buscar o botão *dentro* da Row. |
| **Botão Conferir** | `button[title="Conferir"]` isolado | Fallbacks em cadeia: `button:has-text("Conferir")` > `button[title="Conferir"]` > `button:has(span.material-icons:text-is("visibility"))`. |

---

## 10. CHECKLIST OBRIGATÓRIO (Code Review)
Antes de qualquer submissão de código (Humana ou via IA), valide:
- [ ] Configurações foram adicionadas no arquivo de configuração (`.env`) em vez de chumbadas no código?[cite: 5]
- [ ] Foi inserido algum `sleep()` cego no lugar de um `waitForSelector`? (Se sim, reverta).
- [ ] Há `waitForTimeout` com valor >= 1000ms que poderia ser substituído por `waitForSelector` ou reduzido?
- [ ] A alteração introduz uso de `.jss` ou classes compostas do Material-UI? (Refatore usando acessibilidade/Roles).
- [ ] O fluxo de tratamento de Autocomplete está seguindo o ciclo Click > Clear > Type > Wait API > Click?
- [ ] O tratamento de *Placa Rejeitada* não está acidentalmente capturando outros erros recuperáveis?[cite: 5]

---

## 11. Histórico de Alterações

| Versão | Data | Autor | Mudanças |
| :--- | :--- | :--- | :--- |
| v2.2.2 | — | — | Especificação original |
| v2.2.3 | 2026-07-22 | IA | Correção de locator Conferir (fallbacks), redução de `waitForTimeout`, substituição `networkidle` por `domcontentloaded`/`load`, remoção de `:visible` lento, ajuste de delays em autocomplete, sanetização DADOS_INCOMPLETOS, PLACA_REJEITADA, MODO_EXECUCAO, log naming emiteai-*, guards PaceController. |
| v2.2.4 | 2026-08-10 | IA | Flag de Averbação ativada por padrão: `EMITIR_AVERBACAO=true` garante checkbox "Emitir Averbação" marcado; `desmarcarAverbacao()` tornou-se `configurarAverbacao()` orientado por config. |