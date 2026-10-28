# Bot EmiteAí — Automação de Emissão de Cargas

Bot em **Node.js + Playwright** que automatiza a emissão de CTRCs no portal **EmiteAí** (`portal.emiteai.com.br`) para cargas Shopee, lendo dados de uma planilha **Google Sheets**.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933)
![Playwright](https://img.shields.io/badge/Playwright-1.52-2EAD33)
![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## Contexto do Problema

Uma transportadora recebe diariamente dezenas de cargas Shopee que precisam ser emitidas como CTRC no portal EmiteAí da ANTT. Antes do bot, o processo era 100% manual: um operador abria cada carga no navegador, preenchia o formulário (valor do frete, transportadora, expedidor, motorista), confirmava a emissão e atualizava manualmente a planilha de controle. Além de lento e repetitivo, era fonte de erros — carga esquecida, status desatualizado na planilha, emissão duplicada.

O objetivo deste projeto é automatizar o ciclo completo — leitura da planilha → preenchimento → emissão → validação → atualização da planilha — com execução concorrente para maximizar o throughput dentro da janela produtiva do portal.

## Principais Funcionalidades

- **Pipeline de 3 filas concorrentes** (preenchimento → emissão → validação) com Worker Pool configurável
- **Leitura e escrita automática no Google Sheets** (OAuth2), eliminando o registro manual
- **Preenchimento realista do formulário** (valor, transportadora, expedidor, motorista) via Playwright
- **Resiliência**: retry com backoff exponencial, circuit breaker, watchdog/heartbeat, cooldown exponencial
- **Recuperação automática** de abas com problemas e reprocessamento de cargas
- **Controle adaptativo de concorrência** (PaceController) quando o portal degrada
- **Logging estruturado** (Winston) e **relatório final** com estatísticas por carga
- **67 testes unitários** (Vitest) com mocks de navegador e portal

---

## Índice

- [Contexto do Problema](#contexto-do-problema)
- [Principais Funcionalidades](#principais-funcionalidades)
- [Tecnologias](#tecnologias)
- [Arquitetura](#arquitetura)
- [Pipeline de 3 Filas (F1 → F2 → F3)](#pipeline-de-3-filas-f1--f2--f3)
- [Algoritmos Utilizados](#algoritmos-utilizados)
- [Decisões Técnicas](#decisões-técnicas)
- [Uso de IA no Desenvolvimento](#uso-de-ia-no-desenvolvimento)
- [Estrutura do Projeto](#estrutura-do-projeto)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Como Usar](#como-usar)
- [Relatório de Execução](#relatório-de-execução)
- [Manutenção dos Seletores](#manutenção-dos-seletores)
- [Fluxo de Emissão no Portal](#fluxo-de-emissão-no-portal)
- [Segurança](#segurança)
- [Limitações e Melhorias Futuras](#limitações-e-melhorias-futuras)
- [Licença](#licença)

---

## Tecnologias

| Tecnologia | Versão | Função |
|-----------|--------|--------|
| **Node.js** | 18+ (ESModules) | Runtime principal |
| **Playwright** | ^1.52.0 | Automação do navegador Chromium |
| **Google Sheets API** | v4 | Leitura e escrita de dados da planilha |
| **Winston** | ^3.17.0 | Logging estruturado (arquivo + console colorido) |
| **dotenv** | ^16.4.0 | Configuração via variáveis de ambiente |
| **Vitest** | ^4.1.10 | Testes unitários (devDependency) |

---

## Arquitetura

### Visão Geral (Concorrente com 3 Filas)

```
┌─────────────────────────────────────────────────────────────┐
│                        index.js                             │
│  (BrowserManager + WorkerPool + PipelineOrchestrator)        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
            ┌─────────────────┐
            │  Google Sheets  │
            │  (lerCargas)    │
            └────────┬────────┘
                     │
                     ▼
            ┌─────────────────┐     ┌──────────────────────┐
            │    Fila 1 (FIFO)│────▶│  TabWorker F1-XX     │
            │  (SharedQueue)  │     │  (executarBloco-     │
            │                 │     │   Preenchimento)     │
            └─────────────────┘     └──────────┬───────────┘
                                               │
                            preenchido / pulada / motorista_nao_cadastrado / sem_placa
                                               │
                                               ▼
            ┌─────────────────┐     ┌──────────────────────┐
            │    Fila 2 (FIFO)│────▶│  TabWorker F23-XX    │
            │  (com cooldown  │     │  (executarBloco-     │
            │   exponencial)  │     │   Emissao)           │
            └─────────────────┘     └──────────┬───────────┘
                                               │
                             para_verificar / sucesso / falha
                                               │
                                    ┌──────────┴──────────┐
                                    ▼                     ▼
                           ┌──────────────┐      ┌──────────────┐
                           │   Fila 3     │      │  Concluída   │
                           │  (validação) │      │  (Planilha)  │
                           └──────┬───────┘      └──────────────┘
                                  │
                            ok / falha
                                  │
                            ┌─────┴─────┐
                            │ Concluída │
                            │ (Planilha)│
                            └───────────┘
```

### Worker Pool (Pool de Workers Concorrentes)

O sistema cria dois tipos de workers:

- **Workers F1** (`NUM_WORKERS_F1`, default: 1): Compartilham o contexto do navegador principal (mesma sessão logada). Processam cargas em blocos de `BATCH_SIZE` (default: 20) usando `executarBlocoPreenchimento()`.
- **Workers F23** (`NUM_WORKERS_F23`, default: 4): Cada um cria seu próprio contexto de navegador (nova aba com storageState copiado). Processam uma carga por vez — F2 executa emissão, F3 executa verificação.

Cada worker executa um loop infinito (`_executarWorker()`) que:
1. Verifica se está ativo (não disabled/failed)
2. Chama `pipeline.tick(worker)` para receber trabalho
3. O PipelineOrchestrator decide qual fila processar baseado no `workerType`

### PipelineOrchestrator (Escalonador)

Algoritmo de escalonamento: **Round Robin com prioridade por workerType**.

```
tick(worker):
  se worker é F1 → tenta Fila 1
  se worker é F23 → tenta Fila 2, se vazia → tenta Fila 3
  se nenhuma fila tem trabalho → sleep 1s
```

Workers F1 só processam Fila 1. Workers F23 processam Fila 2 primeiro (emissão), e se estiver vazia, processam Fila 3 (validação). Quando todas as filas estão vazias e todos os workers ociosos, o pipeline encerra.

### CargaContext (Contexto de Cada Carga)

Cada carga é representada por um objeto `CargaContext` que mantém:

- `nomeArquivo`: identificador único
- `tentativas`: contador por fila (`{ fila1, fila2, fila3 }`)
- `timestamps`: entrada em cada fila, conclusão
- `alertas`: histórico de problemas encontrados
- `historico`: log sequencial de etapas percorridas

---

## Pipeline de 3 Filas (F1 → F2 → F3)

### Fila 1 — Preenchimento (FIFO Simples)

**Algoritmo:** FIFO (First-In, First-Out) com retry até 5 tentativas.

**Responsabilidade:** Preencher o formulário de emissão no portal.

**Entrada:** Cargas lidas do Google Sheets com o status configurado em `STATUS_ORIGEM` (ex.: `EM_PROCESSAMENTO`).

**Processamento (`executarBlocoPreenchimento`):**
1. Worker pega um bloco de até `BATCH_SIZE` cargas da fila
2. Para cada carga, executa `Orchestrator.executarPreenchimento()`
3. Resultados possíveis:

| Resultado | Ação |
|-----------|------|
| `'preenchido'` | Move para Fila 2 |
| `'sem_placa'` | Alerta veículo sem placa + move para Fila 2 |
| `'motorista_nao_cadastrado'` | Alerta + move para Fila 2 |
| `'pulada'` | Já "Aguardando Emissão" — move para Fila 2 |
| `'ja_finalizada'` | Conclui carga (sem mover) |
| `'placa_rejeitada'` | Conclui carga com alerta |
| `'erro'` / desconhecido | **Devolve para Fila 1** (retry até 5×) |

**Retry (Novo desde v2.2.3):**
- Se o resultado for `'erro'` ou qualquer valor inesperado, a carga é reinserida no final da Fila 1 via `devolverParaFila1()`
- **Limite:** 5 tentativas (`MAX_TENTATIVAS_FILA1`)
- Após esgotar 5 tentativas, a carga é removida de `_processadas` e recebe alerta `limite_fila1`
- O watchdog do worker continua ativo durante o retry

### Fila 2 — Emissão (FIFO com Cooldown Exponencial)

**Algoritmo:** FIFO com **Cooldown Exponencial** entre retentativas.

**Responsabilidade:** Clicar no botão de emissão (play) e aguardar finalização.

**Entrada:** Cargas pré-preenchidas vindas da Fila 1.

**Processamento (`executarBlocoEmissao`):**
1. Worker pega uma carga por vez usando `pegarProximaFila2()`
2. Clica em "Atualizar" para recarregar status
3. Executa `Orchestrator.executarEmissao()`
4. Resultados:

| Resultado | Ação |
|-----------|------|
| `'para_verificar'` | Move para Fila 3 |
| `'pulada'` | Já finalizada — ignora |
| Outro (`'erro'`) | Devolve para Fila 2 via `devolverParaFila2()` |

**Cooldown Exponencial (para não sobrecarregar o portal):**
```
cooldown = 5s * 2 ^ min(tentativas, 5)
```
- Tentativa 0: 0s (imediato)
- Tentativa 1: 10s
- Tentativa 2: 20s
- Tentativa 3: 40s
- Tentativa 4: 80s
- Tentativa 5+: 160s (cap)

**Limite:** 25 tentativas (`MAX_TENTATIVAS_FILA2`). Após isso, carga é descartada com alerta.

### Fila 3 — Validação (FIFO Simples com Retry)

**Algoritmo:** FIFO simples com retry limitado.

**Responsabilidade:** Verificar se a carga foi finalizada corretamente no portal e atualizar a planilha.

**Entrada:** Cargas emitidas com sucesso mas que precisam de confirmação visual.

**Processamento (`executarBlocoVerificacao`):**
1. Worker pega carga via `pegarProximaFila3()`
2. Clica em "Atualizar", lê status no portal
3. Executa `Orchestrator.verificarCarga()`
4. Resultados:

| Resultado | Ação |
|-----------|------|
| `'ok'` / `'motorista_nao_cadastrado'` / `'veiculo_sem_placa'` | Conclui carga + atualiza planilha |
| `'nao_encontrado'` / `'status_desconhecido'` | Devolve para Fila 3 |
| `'aguardando_play'` | Devolve para Fila 2 (precisa emitir novamente) |

**Limite:** `MAX_REPROCESS_PER_CARGA` (default: 2). Após isso, carga descartada.

### Resumo de Todas as Filas

| Fila | Algoritmo | Responsabilidade | Limite Retry | Cooldown |
|------|-----------|-----------------|-------------|----------|
| **F1** | FIFO + Retry Limitado | Preenchimento do formulário | 5 tentativas | Nenhum |
| **F2** | FIFO + Cooldown Exponencial | Emissão no portal | 25 tentativas | 5s × 2^tent |
| **F3** | FIFO + Retry Limitado | Validação final | 2 tentativas | Nenhum |

---

## Algoritmos Utilizados

### FIFO (First-In, First-Out) — Fila 1, 2 e 3
Todas as filas usam `Array.shift()` (dequeue) para remover do início e `Array.push()` (enqueue) para adicionar ao final. Cargas mais antigas são processadas primeiro. A estrutura é protegida por um mutex simples (`_comLock`) para evitar race conditions entre workers.

### Round Robin — PipelineOrchestrator.tick()
O pipeline alterna entre workers disponíveis: em cada `tick()`, o worker tenta a fila correspondente ao seu tipo. Como todos os workers rodam `await pipeline.tick(worker)` em paralelo, a distribuição é aproximadamente Round Robin.

### Cooldown Exponencial — Fila 2
Após cada falha na emissão, a carga espera um tempo que dobra a cada tentativa:
```
cooldown = COOLDOWN_FILA2_MS * 2 ^ min(tentativas, 5)
```
Isso evita sobrecarregar o portal com retentativas rápidas e dá tempo para problemas transitórios se resolverem.

### Retry com Backoff Exponencial — API Google Sheets e Operações Genéricas
O utilitário `retryAsync()` em `src/utils/retry.js` implementa:
```
delay = min(baseDelay * 2^(attempt - 1), maxDelay)
```
Usado para chamadas à API do Google Sheets (3 tentativas, delay base de 2s).

### Polling com Backoff (Linear + Multiplicativo) — Aguardar Finalização
`aguardarCondicao()` em `src/utils/retry.js` faz polling do status da carga:
```
intervalo = min(intervalo * 1.2, intervaloMaximo)
```
Começa em 1s e cresce até 1.2s. Timeout máximo de 250s.

### Circuit Breaker — Workers
Cada worker conta falhas consecutivas em `_contagemFalhas`. Se exceder `MAX_RECOVERY_PER_TAB` (default: 3), o worker entra em estado `FAILED` e é substituído pelo WorkerPool.

### Watchdog Timer / Heartbeat — Workers
Cada worker emite um heartbeat a cada 5s. Um watchdog timer verifica a cada 10s se o heartbeat está atualizado. Se o worker ficar parado por mais de `IDLENESS_TIMEOUT_MS` (180s), o watchdog força uma recuperação via `_recuperarPorWatchdog()`.

### Adaptive Concurrency (PaceController)
O `PaceController` monitora o tempo médio de processamento das cargas (janela móvel de 5). Se detecta degradação (tempo acima do baseline + threshold), reduz automaticamente o número de workers ativos. Quando a performance se recupera, reativa workers desativados.

```
Baseline = média móvel exponencial (70% anterior + 30% nova)
Degradação = duração - baseline
Se degradação >= PACE_DEGRADATION_THRESHOLD_MS (90s) por 3× consecutivas:
    → desativa 1 worker
    → entra em estabilização por PACE_STABILIZATION_WAIT_MS (120s)
```

---

## Decisões Técnicas

| Decisão | Motivo |
|---------|--------|
| **Playwright** (não Puppeteer/Selenium) | API mais robusta para auto-wait, seletores por papel/nome acessível (`getByRole`) e contextos isolados por worker |
| **3 filas separadas (F1/F2/F3)** em vez de fila única | Cada etapa tem falha, retry e cooldown próprios; a validação não bloqueia novas emissões |
| **Workers F23 com contexto isolado** (storageState copiado) | Emissão e validação rodam em paralelo sem disputar a sessão principal |
| **Persistência de sessão via perfil Chrome** | Evita re-login e re-solução de Cloudflare a cada execução |
| **Backoff exponencial** nas APIs e no portal | Google Sheets tem cota por minuto; o portal degrada sob carga |
| **Configuração 100% via `.env`** | Nenhum dado sensível ou específico de ambiente no código-fonte |

---

## Uso de IA no Desenvolvimento

O bot nasceu de um problema real do dia a dia (o processo manual descrito em [Contexto do Problema](#contexto-do-problema)) e foi construído do zero com apoio de LLMs.

1. **Pesquisa:** antes de implementar, usei uma LLM para pesquisar as melhores formas de automatizar o processo.
2. **Ferramenta:** como não tinha como pagar por uma assinatura, usei o **opencode** como agente de código.
3. **Evolução versão a versão:** o agente foi sendo "treinado" com contexto a cada versão, com uma estratégia semelhante à que usei no CupHub: contexto por tarefa e implementação seguindo o plano definido.
4. **Planejamento com Superpowers:** a cada versão, usei a skill **Superpowers** (sub-skills de *brainstorming* e de *perguntas*) para enriquecer o prompt e refinar o plano antes da implementação.
5. **Adequação ao ambiente:** com o tempo, refinei esse contexto para refletir o funcionamento do portal e o modelo de operação da empresa, o que melhorou a aderência das implementações ao cenário real.

## Estrutura do Projeto

```
bot_emissao_lm_2.2.3/
├── src/
│   ├── index.js                          # Ponto de entrada (main)
│   ├── config.js                         # Variáveis de ambiente + constantes
│   ├── logger.js                         # Winston (arquivo JSON + console ANSI)
│   ├── orchestrator.js                   # Orquestrador de fluxo no portal
│   ├── relatorio.js                      # Relatório final de execução
│   ├──
│   ├── browser/
│   │   ├── manager.js                    # BrowserManager: Chromium launch + perfil persistente
│   │   └── cloudflare.js                 # Detecção e espera de resolução Cloudflare
│   ├──
│   ├── context/
│   │   └── carga-context.js              # CargaContext: estado individual de cada carga
│   ├──
│   ├── sheets/
│   │   ├── auth.js                       # Script de autorização OAuth2
│   │   └── client.js                     # SheetsRepository: API Google Sheets
│   ├──
│   ├── pipeline/
│   │   └── pipeline-orchestrator.js      # PipelineOrchestrator: escalonador Round Robin
│   ├──
│   ├── workers/
│   │   ├── tab-worker.js                 # TabWorker: processa blocos de cargas (F1/F2/F3)
│   │   ├── worker-pool.js                # WorkerPool: gerencia ciclo de vida dos workers
│   │   ├── shared-queue.js               # SharedQueueManager: filas FIFO thread-safe
│   │   ├── recovery.js                   # RecoveryManager: recuperação de falhas
│   │   └── health-checker.js             # HealthChecker: estabilidade da página
│   ├──
│   ├── pages/
│   │   ├── base.page.js                  # BasePage: utilidades comuns de navegação
│   │   ├── consulta.page.js              # ConsultaPage: tela de consulta/filtro/tabela
│   │   ├── form.page.js                  # FormPage: formulário de emissão
│   │   └── popups.page.js                # PopupsPage: diálogos e confirmações
│   ├──
│   ├── metrics/
│   │   ├── collector.js                  # MetricsCollector: métricas por worker
│   │   └── pace-controller.js            # PaceController: controle adaptativo de concorrência
│   ├──
│   └── utils/
│       └── retry.js                      # retryAsync (backoff) + aguardarCondicao (polling)
│
├── logs/                                 # Logs diários (JSON, rotação 5MB × 5 arquivos)
├── tests/                                # Testes Vitest
├── .env                                  # Configurações (não versionado)
├── .env.example                          # Modelo de configuração para novos usuários
├── credentials.json                      # OAuth2 credentials (não versionado)
├── token.json                            # Token de acesso (gerado na 1ª execução)
├── BOT_SPECIFICATION.md                  # Especificação técnica detalhada
├── LICENSE                               # Licença MIT
├── package.json
└── README.md                             # Este arquivo
```

---

## Fluxo de Emissão no Portal

### Fluxo 1 — Preenchimento (F1)

Para cargas com status diferente de "Aguardando Emissão":

```
1. Abre filtro de consulta (data últimos 30 dias)
2. Pesquisa pelo nome do arquivo na tabela
3. Clica em "Conferir" na linha da carga
4. Verifica notificação de "Veículo sem placa" (timeout 3s, se aparecer marca alerta)
5. Preenche formulário:
   a. Garante que "Emitir Averbação" esteja marcado (conforme `EMITIR_AVERBACAO` no `.env`)
   b. Preenche Valor (digita caractere por caractere com type(), confirma com Tab)
   c. Preenche Transportadora (autocomplete, seleciona por texto exato)
   d. Preenche Expedidor (autocomplete por CNPJ, matching com remoção de não-alfanuméricos)
   e. Preenche Motorista (autocomplete, seleciona por nome)
6. Clica em "EmiteAí" (ou "Emitir")
7. Trata popup "Atenção — Frete Mínimo ANTT" se aparecer (timeout 2s)
8. Confirma popup "Você confirma a emissão?" → Sim
9. Inicia polling até status mudar para "Carga Finalizada" (timeout 250s)
```

### Fluxo 2 — Emissão (F2)

Para cargas já em "Aguardando Emissão":

```
1. Clica em "Atualizar" para recarregar status
2. Localiza o botão play (ícone) na linha da carga
3. Clica no play
4. Confirma popup "Você confirma a emissão?" → Sim
5. Fecha popup de sucesso
6. Polling até "Carga Finalizada" (timeout 250s)
```

### Fluxo 3 — Validação (F3)

```
1. Clica em "Atualizar"
2. Lê o status atual da carga no portal
3. Se "Carga Finalizada" → conclui e atualiza planilha
4. Se "Aguardando Emissão" → devolve para Fila 2 (precisa de play)
5. Se status desconhecido → retenta na Fila 3
```

---

## Pré-requisitos

- **Node.js** 18+ (ESModules nativo)
- **npm**
- **Google Sheets** com credenciais de API configuradas
- **Chromium** (instalado pelo Playwright)

---

## Instalação

```bash
npm install
npx playwright install chromium
```

---

## Configuração

### 1. Credenciais Google Sheets

Coloque `credentials.json` (OAuth 2.0 — tipo "Desktop app") na raiz do projeto.
Obtenha no [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → Create OAuth client ID.

**Escopos necessários:**
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/drive`

### 2. Autorização (primeira execução)

```bash
node src/sheets/auth.js
```

Isso abrirá um link no navegador. Após autorizar, `token.json` será salvo na raiz.

### 3. Arquivo `.env`

```env
# ID da planilha (da URL: https://docs.google.com/spreadsheets/d/<ID>/edit)
GOOGLE_SHEETS_ID=seu_id_aqui

# GID da aba (número no final da URL depois de #gid=)
GOOGLE_SHEETS_GID=0

# Nome da transportadora padrão (usada no autocomplete do formulário)
TRANSPORTADORA=00.000.000/0000-00 - NOME DA TRANSPORTADORA

# Status na planilha que indica carga pendente (case insensitive)
STATUS_ORIGEM=EM_PROCESSAMENTO

# Status a escrever após finalizar
STATUS_FINAL=CARGA_FINALIZADA
STATUS_VEICULO_SEM_PLACA=VEICULO_SEM_PLACA

# Marca (true) ou desmarca (false) o checkbox "Emitir Averbação" no formulário
EMITIR_AVERBACAO=true

# Número de workers F1 (preenchimento)
NUM_WORKERS_F1=1

# Número de workers F2/F3 (emissão/validação)
NUM_WORKERS_F23=4

# Tamanho do bloco de cargas por vez na Fila 1
BATCH_SIZE=20

# Modo de execução: 'headless' ou 'desenvolvimento'
MODO_EXECUCAO=desenvolvimento

# Diretório do perfil Chrome (mantém sessão logada entre execuções)
CHROME_USER_DATA=chrome_bot_profile
```

---

## Como Usar

```bash
# Modo produção — abre navegador, processa cargas, fecha ao final
npm start

# Modo desenvolvimento — navegador permanece aberto após execução
npm run dev
```

### O que acontece ao iniciar

1. **index.js** carrega configurações do `.env` e inicia o `BrowserManager`
2. Chromium abre com perfil persistente (`CHROME_USER_DATA`), mantendo sessão logada
3. Navega para `portal.emiteai.com.br/...consulta` (últimos 30 dias)
4. Aguarda resolução do Cloudflare (até 120s)
5. Aguarda carregamento da tabela
6. **WorkerPool** cria workers:
   - `NUM_WORKERS_F1` workers F1 (contexto principal)
   - `NUM_WORKERS_F23` workers F23 (contextos isolados)
7. **SheetsRepository** lê cargas pendentes do Google Sheets (filtro por `STATUS_ORIGEM`)
8. Cargas são adicionadas à **Fila 1**
9. **PipelineOrchestrator** inicia loop de escalonamento Round Robin
10. Workers processam concorrentemente até todas as filas esgotarem
11. **Relatório** é exibido no console com estatísticas
12. Em modo produção, navegador é fechado

### Parando o bot

- **Ctrl + C** interrompe graciosamente (workers finalizam carga atual, navegador fecha)
- O bot para automaticamente após todas as filas estarem vazias

---

## Relatório de Execução

Ao final, o bot imprime um relatório com:

```
=============================================================
Inicio: 14:30:00  |  Termino: 15:45:23  |  Duracao: 75m 23s
=============================================================
CARGA                            STATUS                     TENT F2
──────────────────────────────── ─────────────────────────── ────────
AT202607207HHW6                  CARGA_FINALIZADA                   0
AT202607208AB12                  DESCARTADA_F2                      5
AT202607209CD34                  MOTORISTA_NAO_CADASTRADO           0
...
=============================================================
Total: 50  |  Finalizadas: 42  |  Descartadas: 5  |  Em processamento: 3
Throughput: 0.67 cargas/min
=============================================================
```

### Status Finais Possíveis

| Status | Significado |
|--------|-------------|
| `CARGA_FINALIZADA` | Emitida e verificada com sucesso |
| `VEICULO_SEM_PLACA` | Veículo sem placa detectado |
| `MOTORISTA_NAO_CADASTRADO` | Motorista não encontrado no sistema |
| `PLACA_REJEITADA` | Placa rejeitada pelo servidor |
| `DESCARTADA_F2` | Excedeu 25 tentativas na Fila 2 |
| `DESCARTADA_F3` | Excedeu limite de reprocessamento na Fila 3 |
| `DESCARTADA_F1` | Excedeu 5 tentativas na Fila 1 |
| `EM_PROCESSAMENTO` | Ainda em andamento ou travada |

---

## Manutenção dos Seletores

Os seletores Playwright foram mapeados manualmente contra o HTML real do portal, seguindo a ordem de prioridade:

1. Atributo estável (`id`, `data-testid`)
2. Papel semântico + nome acessível (`getByRole`)
3. Texto visível estável
4. Atributos escopados dentro de container
5. Posição no DOM (último recurso)

Se o portal for atualizado e os seletores quebrarem, use:

```bash
npx playwright codegen https://portal.emiteai.com.br
```

---

## Notas de Performance

### Degradação Conhecida do Portal

Observou-se que o portal EmiteAí sofre degradação severa após ~16h40:
- **14h-16h30:** janela produtiva ideal (30-40 emissões/hora)
- **Após 16h40:** taxa de falha próxima de 100%

O PaceController foi implementado para mitigar isso reduzindo automaticamente a concorrência quando detecta degradação.

### Throughput Esperado

- 30-40 cargas/hora na janela produtiva
- Aprox. 2 min por carga (incluindo preenchimento + emissão + validação)

---

## Segurança

- **`.env`, `credentials.json` e `token.json` não são versionados** (ver `.gitignore`) — contêm credenciais reais do Google e dados da planilha.
- Cada usuário deve criar um **OAuth Client ID próprio** no Google Cloud Console e rodar `node src/sheets/auth.js` para gerar seu `token.json` local.
- **Rotacione as credenciais** se o projeto já foi executado em outra máquina.
- Os logs podem conter nomes de cargas reais — **não publique a pasta `logs/`**.

---

## Limitações e Melhorias Futuras

### Limitações

- Depende do HTML do portal EmiteAí — atualizações do portal podem quebrar seletores (ver "Manutenção dos Seletores").
- O portal sofre degradação severa após ~16h40 (janela produtiva limitada) — o bot reduz a concorrência automaticamente, mas não elimina o efeito.
- É um processo de longa duração com navegador real; não é adequado para execução serverless.
- `config.js` interrompe o processo na importação se `credentials.json` não existir (fail-fast intencional).

### Melhorias Futuras

- Remover o fluxo legado "Passada 1/Passada 2" (`executar()`/`parar()` em `orchestrator.js`) — código morto desde a adoção do pipeline F1/F2/F3.
- Conectar `PaceController`/`MetricsCollector` ao fluxo ativo do pipeline (hoje a concorrência adaptativa só roda no fluxo legado).
- Corrigir a race condition na terminação do pipeline e o cooldown exponencial da Fila 2 (implementação difere da documentação).
- Substituir o `process.exit(1)` do `config.js` por erro explícito, permitindo testes em CI sem credenciais.
- Adicionar testes de integração (headless) e pipeline CI no GitHub Actions.

---

## Licença

Distribuído sob a licença **MIT** — veja [LICENSE](LICENSE).
