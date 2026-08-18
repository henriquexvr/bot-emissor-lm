import { logInfo, logAviso, logErro, logSucesso, logEstado } from '../logger.js';
import { Orchestrator } from '../orchestrator.js';
import { RecoveryManager } from './recovery.js';
import { HealthChecker } from './health-checker.js';
import {
  MAX_RECOVERY_PER_TAB,
  MAX_REPROCESS_PER_CARGA,
  IDLENESS_TIMEOUT_MS,
  MAX_CARGA_TIMEOUT_MS,
} from '../config.js';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export const ESTADOS = {
  IDLE: 'idle',
  SEARCHING: 'searching',
  PROCESSING: 'processing',
  WAITING: 'waiting',
  RECOVERING: 'recovering',
  FINISHED: 'finished',
  DISABLED: 'disabled',
  FAILED: 'failed',
};

export class TabWorker {
  constructor(context, workerId, metricsCollector, workerType = 'f23') {
    this._context = context;
    this._workerId = workerId;
    this._workerType = workerType;
    this._metrics = metricsCollector;
    this._state = ESTADOS.IDLE;
    this._page = null;
    this._orchestrator = null;
    this._recoveryManager = null;
    this._healthChecker = null;
    this._cargaAtual = null;
    this._contagemFalhas = 0;
    this._contagemReinicializacoes = 0;
    this._timestampInicioCarga = 0;
    this._ultimaAcao = null;
    this._deveParar = false;
    this._heartbeatInterval = null;
    this._watchdogTimer = null;
    this._ultimoHeartbeat = 0;
    this._etapaAtual = null;
    this._pipelineOrchestrator = null;
    this._contadorCargasF1 = 0;
  }

  get workerId() { return this._workerId; }
  get workerType() { return this._workerType; }
  get state() { return this._state; }
  get isIdle() { return this._state === ESTADOS.IDLE || this._state === ESTADOS.DISABLED; }
  get isProcessing() { return this._state === ESTADOS.PROCESSING || this._state === ESTADOS.SEARCHING; }
  get isDisabled() { return this._state === ESTADOS.DISABLED; }
  get isFailed() { return this._state === ESTADOS.FAILED; }
  get etapaAtual() { return this._etapaAtual; }

  setPipelineOrchestrator(po) {
    this._pipelineOrchestrator = po;
  }

  _setEstado(novoEstado) {
    const anterior = this._state;
    this._state = novoEstado;
    if (anterior !== novoEstado) {
      logEstado(`Worker ${this._workerId}: ${anterior} → ${novoEstado}`, {
        worker: this._workerId,
        carga: this._cargaAtual?.nomeArquivo,
        estado: novoEstado,
        etapa: this._etapaAtual,
      });
    }
  }

  _setEtapa(etapa) {
    this._etapaAtual = etapa;
    logInfo(`Worker ${this._workerId}: etapa ${etapa}`, {
      worker: this._workerId,
      carga: this._cargaAtual?.nomeArquivo,
      etapa,
      estado: this._state,
    });
  }

  async inicializar() {
    this._page = await this._context.newPage();
    this._orchestrator = new Orchestrator(this._page);
    this._recoveryManager = new RecoveryManager(this._page, this._workerId);
    this._healthChecker = new HealthChecker(this._page, this._workerId);

    await this._orchestrator._consulta.navegarParaConsulta();
    await this._orchestrator._consulta.abrirFiltro();
    await this._orchestrator._consulta.definirDatas();

    this._iniciarHeartbeat();
    this._iniciarWatchdog();

    logInfo(`Worker ${this._workerId} inicializado`);
  }

  _iniciarHeartbeat() {
    this._pararHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      this._ultimoHeartbeat = Date.now();
    }, 5000);
    this._ultimoHeartbeat = Date.now();
  }

  _pararHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  _iniciarWatchdog() {
    this._pararWatchdog();
    this._watchdogTimer = setInterval(() => {
      const idleTime = Date.now() - this._ultimoHeartbeat;
      if (idleTime >= IDLENESS_TIMEOUT_MS && this._state !== ESTADOS.IDLE && this._state !== ESTADOS.DISABLED && this._state !== ESTADOS.FINISHED) {
        logAviso(`Worker ${this._workerId}: watchdog acionado (${(idleTime / 1000).toFixed(0)}s ocioso)`, {
          worker: this._workerId,
          carga: this._cargaAtual?.nomeArquivo,
          estado: this._state,
          etapa: this._etapaAtual,
        });
        this._recuperarPorWatchdog();
      }
    }, 10000);
  }

  _pararWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  async _recuperarPorWatchdog() {
    const cargaBackup = this._cargaAtual;
    const etapaBackup = this._etapaAtual;

    this._setEstado(ESTADOS.RECOVERING);
    try {
      const recuperou = await this._recoveryManager.recarregarAba();
      if (recuperou) {
        this._cargaAtual = cargaBackup;
        this._etapaAtual = etapaBackup;
        this._ultimoHeartbeat = Date.now();
        if (this._cargaAtual) {
          this._setEstado(ESTADOS.PROCESSING);
          logInfo(`Worker ${this._workerId}: recuperado por watchdog, continuando etapa ${etapaBackup}`, {
            worker: this._workerId,
            carga: this._cargaAtual?.nomeArquivo,
          });
        } else {
          this._setEstado(ESTADOS.IDLE);
        }
      } else {
        this._setEstado(ESTADOS.FAILED);
      }
    } catch (err) {
      logErro(`Worker ${this._workerId}: falha na recuperacao do watchdog`, {
        worker: this._workerId,
        erro: err.message,
      });
      this._setEstado(ESTADOS.FAILED);
    }
  }

  async executarBlocoPreenchimento(blocos, queueManager) {
    this._cargaAtual = blocos[0];
    this._setEstado(ESTADOS.PROCESSING);
    this._setEtapa('preenchimento');

    for (const carga of blocos) {
      this._cargaAtual = carga;
      this._timestampInicioCarga = Date.now();

      try {
        await this._reinicializarPaginaSeNecessario();
        if (this._contadorCargasF1 >= 10) {
          await this._forcarRecargaPagina();
          this._contadorCargasF1 = 0;
        }
        this._setEtapa(`preenchimento:${carga.nomeArquivo}`);

        const resultado = await this._orchestrator.executarPreenchimento(carga);

        if (resultado === 'preenchido' || resultado === 'sem_placa') {
          if (carga.veiculoSemPlaca || resultado === 'sem_placa') {
            carga.veiculoSemPlaca = true;
            carga.addAlerta('veiculo_sem_placa', 'Veículo sem placa detectado durante preenchimento');
          }
          if (carga.placaNaoCadastrada) {
            if (!carga.alertas.some(a => a.tipo === 'placa_nao_cadastrada')) {
              carga.addAlerta('placa_nao_cadastrada', 'Placa não cadastrada/encontrada no portal');
            }
          }
          if (carga.motoristaNaoCadastrado || resultado === 'motorista_nao_cadastrado' || resultado === 'sem_placa') {
            carga.motoristaNaoCadastrado = true;
            if (!carga.alertas.some(a => a.tipo === 'motorista_nao_cadastrado')) {
              carga.addAlerta('motorista_nao_cadastrado', 'Motorista não cadastrado no sistema');
            }
          }
          await queueManager.moverParaFila2(carga);
          this._contadorCargasF1++;
          logSucesso(`Worker ${this._workerId}: carga preenchida (Fila 1)`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
            fila: 'fila1',
          });
        } else if (resultado === 'pulada') {
          await queueManager.moverParaFila2(carga);
          logInfo(`Worker ${this._workerId}: carga ja aguardando emissao, movida para Fila 2`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
            fila: 'fila1',
          });
        } else if (resultado === 'ja_finalizada') {
          carga.addAlerta('ja_finalizada', 'Carga já estava finalizada no portal');
          carga.concluir();
          logInfo(`Worker ${this._workerId}: carga ${resultado}`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
          });
        } else if (resultado === 'placa_rejeitada') {
          carga.placaRejeitada = true;
          carga.addAlerta('placa_rejeitada', 'Placa rejeitada pelo servidor');
          carga.concluir();
          logInfo(`Worker ${this._workerId}: placa rejeitada`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
          });
        } else if (resultado === 'placa_nao_cadastrada') {
          carga.placaNaoCadastrada = true;
          carga.addAlerta('placa_nao_cadastrada', 'Placa não cadastrada/encontrada no portal');
          carga.concluir();
          logInfo(`Worker ${this._workerId}: placa nao cadastrada, pulando`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
          });
        } else if (resultado === 'motorista_nao_cadastrado') {
          carga.motoristaNaoCadastrado = true;
          carga.addAlerta('motorista_nao_cadastrado', 'Motorista não cadastrado no sistema');
          carga.concluir();
          logInfo(`Worker ${this._workerId}: motorista nao cadastrado`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
          });
        } else {
          logAviso(`Worker ${this._workerId}: falha no preenchimento, devolvendo para Fila 1`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
            resultado,
          });
          await queueManager.devolverParaFila1(carga);
          await this._salvarDiagnosticoErro(carga.nomeArquivo, 'falha_preenchimento_' + resultado);
        }
      } catch (err) {
        logErro(`Worker ${this._workerId}: erro no preenchimento, devolvendo para Fila 1`, {
          worker: this._workerId,
          carga: carga.nomeArquivo,
          erro: err.message,
        });
        await queueManager.devolverParaFila1(carga);
        await this._salvarDiagnosticoErro(carga.nomeArquivo, 'erro_preenchimento');
      }
    }

    this._setEstado(ESTADOS.IDLE);
    this._setEtapa(null);
    this._cargaAtual = null;
  }

  async executarBlocoEmissao(blocos, queueManager) {
    this._cargaAtual = blocos[0];
    this._setEstado(ESTADOS.PROCESSING);
    this._setEtapa('emissao');

    for (const carga of blocos) {
      this._cargaAtual = carga;
      this._timestampInicioCarga = Date.now();

      try {
        await this._reinicializarPaginaSeNecessario();
        this._setEtapa(`emissao:${carga.nomeArquivo}`);

        await this._orchestrator._consulta.clicarAtualizar();
        await this._sleep(1000);

        const resultado = await this._orchestrator.executarEmissao(carga);

        if (resultado === 'para_verificar') {
          await queueManager.moverParaFila3(carga);
          logSucesso(`Worker ${this._workerId}: carga movida para Fila 3`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
            fila: 'fila2',
          });
        } else if (resultado === 'pulada') {
          logInfo(`Worker ${this._workerId}: carga pulada na emissao`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
          });
        } else {
          logAviso(`Worker ${this._workerId}: falha na emissao, devolvendo para Fila 2`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
            resultado,
          });
          await queueManager.devolverParaFila2(carga);
          await this._salvarDiagnosticoErro(carga.nomeArquivo, 'falha_emissao_' + resultado);
        }
      } catch (err) {
        logErro(`Worker ${this._workerId}: erro na emissao, devolvendo para Fila 2`, {
          worker: this._workerId,
          carga: carga.nomeArquivo,
          erro: err.message,
        });
        await queueManager.devolverParaFila2(carga);
        await this._salvarDiagnosticoErro(carga.nomeArquivo, 'erro_emissao');
      }
    }

    this._setEstado(ESTADOS.IDLE);
    this._setEtapa(null);
    this._cargaAtual = null;
  }

  async executarBlocoVerificacao(blocos, queueManager) {
    this._cargaAtual = blocos[0];
    this._setEstado(ESTADOS.PROCESSING);
    this._setEtapa('validacao');

    for (const carga of blocos) {
      this._cargaAtual = carga;
      this._timestampInicioCarga = Date.now();

      try {
        await this._reinicializarPaginaSeNecessario();
        this._setEtapa(`validacao:${carga.nomeArquivo}`);

        await this._orchestrator._consulta.clicarAtualizar();
        await this._sleep(1000);

        const resultado = await this._orchestrator.verificarCarga(carga);

        if (resultado === 'ok' || resultado === 'motorista_nao_cadastrado' || resultado === 'veiculo_sem_placa' || resultado === 'placa_nao_cadastrada') {
          carga.concluir();
          logSucesso(`Worker ${this._workerId}: carga verificada e finalizada`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
            resultado,
            fila: 'fila3',
          });
        } else if (resultado === 'nao_encontrado' || resultado === 'status_desconhecido') {
          logAviso(`Worker ${this._workerId}: falha na verificacao, devolvendo para Fila 3`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
            resultado,
          });
          await queueManager.devolverParaFila3(carga);
          await this._salvarDiagnosticoErro(carga.nomeArquivo, 'falha_verificacao_' + resultado);
        } else if (resultado === 'aguardando_play') {
          logAviso(`Worker ${this._workerId}: carga ainda Aguardando Emissao, precisa de play`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
          });
          await queueManager.devolverParaFila2(carga);
        } else {
          logAviso(`Worker ${this._workerId}: erro na verificacao, devolvendo para Fila 3`, {
            worker: this._workerId,
            carga: carga.nomeArquivo,
            resultado,
          });
          await queueManager.devolverParaFila3(carga);
          await this._salvarDiagnosticoErro(carga.nomeArquivo, 'erro_verificacao_' + resultado);
        }
      } catch (err) {
        logErro(`Worker ${this._workerId}: erro na verificacao, devolvendo para Fila 3`, {
          worker: this._workerId,
          carga: carga.nomeArquivo,
          erro: err.message,
        });
        await queueManager.devolverParaFila3(carga);
        await this._salvarDiagnosticoErro(carga.nomeArquivo, 'erro_verificacao');
      }
    }

    this._setEstado(ESTADOS.IDLE);
    this._setEtapa(null);
    this._cargaAtual = null;
  }

  async executarCarga(carga) {
    this._cargaAtual = carga;
    const inicioTotal = Date.now();

    while (true) {
      const elapsed = Date.now() - inicioTotal;
      if (elapsed >= MAX_CARGA_TIMEOUT_MS) {
        logAviso(`Worker ${this._workerId}: timeout global da carga atingido (${(elapsed / 1000).toFixed(0)}s)`, {
          worker: this._workerId,
          carga: carga.nomeArquivo,
        });
        this._pararWatchdog();
        this._metrics.registrarCargaConcluida(this._workerId, elapsed, false);
        this._setEstado(ESTADOS.IDLE);
        return { sucesso: false, resultado: 'erro', motivo: 'timeout_carga', precisaRetry: false };
      }

      const resultado = await this._tentarProcessar(carga);

      if (resultado.precisaRetry) {
        continue;
      }

      return resultado;
    }
  }

  async _tentarProcessar(carga) {
    if (this._state === ESTADOS.RECOVERING) {
      this._setEstado(ESTADOS.SEARCHING);
    }

    this._setEstado(ESTADOS.SEARCHING);
    this._timestampInicioCarga = Date.now();
    this._ultimoHeartbeat = Date.now();

    try {
      await this._reinicializarPaginaSeNecessario();
      this._setEstado(ESTADOS.PROCESSING);

      const resultado = await this._orchestrator.executarFluxo(carga);
      this._ultimaAcao = this._orchestrator._ultimaAcao || null;

      this._pararWatchdog();
      const duracao = Date.now() - this._timestampInicioCarga;

      if (['ok', 'sem_placa', 'ja_finalizada'].includes(resultado)) {
        this._metrics.registrarCargaConcluida(this._workerId, duracao, true);
        logSucesso(`Worker ${this._workerId}: carga concluída`, {
          worker: this._workerId,
          carga: carga.nomeArquivo,
          duracao: `${(duracao / 1000).toFixed(1)}s`,
        });
        this._contagemFalhas = 0;
        this._setEstado(ESTADOS.IDLE);
        return { sucesso: true, resultado, precisaRetry: false };
      }

      return await this._tratarErro(carga, { tipo: 'fluxo', message: `Resultado: ${resultado}` });
    } catch (err) {
      this._pararWatchdog();
      return await this._tratarErro(carga, err);
    }
  }

  async _tratarErro(carga, erro) {
    this._setEstado(ESTADOS.RECOVERING);
    logAviso(`Worker ${this._workerId}: erro detectado, tentando recuperação`, {
      worker: this._workerId,
      carga: carga.nomeArquivo,
      erro: erro.message || String(erro),
      etapa: this._etapaAtual,
    });

    const recuperacao = await this._recoveryManager.recuperar(erro, this._ultimaAcao);

    if (recuperacao.sucesso) {
      this._contagemReinicializacoes++;
      this._metrics.registrarReinicializacao(this._workerId);
      this._ultimoHeartbeat = Date.now();
      logInfo(`Worker ${this._workerId}: recuperação bem-sucedida, retomando`, {
        worker: this._workerId,
        carga: carga.nomeArquivo,
      });
      this._iniciarWatchdog();
      return { sucesso: false, resultado: 'recuperado', precisaRetry: true };
    }

    this._contagemFalhas++;
    if (this._contagemFalhas >= MAX_RECOVERY_PER_TAB) {
      logErro(`Worker ${this._workerId}: limite de recuperações atingido`, {
        worker: this._workerId,
        carga: carga.nomeArquivo,
        falhas: this._contagemFalhas,
      });
      this._setEstado(ESTADOS.FAILED);
      this._metrics.registrarCargaConcluida(this._workerId, Date.now() - this._timestampInicioCarga, false);
      return { sucesso: false, resultado: 'erro', motivo: 'limite_recuperacao', precisaRetry: false };
    }

    logAviso(`Worker ${this._workerId}: recuperação falhou, tentando recarregar aba`, {
      worker: this._workerId,
      carga: carga.nomeArquivo,
    });

    const recarregou = await this._recoveryManager.recarregarAba();
    if (recarregou) {
      this._contagemReinicializacoes++;
      this._metrics.registrarReinicializacao(this._workerId);
      this._ultimoHeartbeat = Date.now();
      this._iniciarWatchdog();
      return { sucesso: false, resultado: 'recarregado', precisaRetry: true };
    }

    this._metrics.registrarCargaConcluida(this._workerId, Date.now() - this._timestampInicioCarga, false);
    this._setEstado(ESTADOS.IDLE);
    return { sucesso: false, resultado: 'erro', motivo: 'falha_recuperacao', precisaRetry: false };
  }

  async _reinicializarPaginaSeNecessario() {
    if (!this._page || this._page.isClosed()) {
      logInfo(`Worker ${this._workerId}: reinicializando página fechada`, {
        worker: this._workerId,
        carga: this._cargaAtual?.nomeArquivo,
      });
      try {
        this._page = await this._context.newPage();
      } catch (err) {
        logAviso(`Worker ${this._workerId}: falha ao criar nova página`, {
          worker: this._workerId,
          erro: err.message,
        });
        throw err;
      }
      this._orchestrator = new Orchestrator(this._page);
      this._recoveryManager = new RecoveryManager(this._page, this._workerId);
      this._healthChecker = new HealthChecker(this._page, this._workerId);

      await this._orchestrator._consulta.navegarParaConsulta();
      await this._orchestrator._consulta.abrirFiltro();
      await this._orchestrator._consulta.definirDatas();

      this._contagemReinicializacoes++;
      this._metrics.registrarReinicializacao(this._workerId);
    }
  }

  async _forcarRecargaPagina() {
    logInfo(`Worker ${this._workerId}: recarregando pagina (limpeza periodica F1)`, {
      worker: this._workerId,
      carga: this._cargaAtual?.nomeArquivo,
      contador: this._contadorCargasF1,
    });
    try {
      await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._page.waitForTimeout(2000);
      await this._orchestrator._consulta.navegarParaConsulta();
      await this._orchestrator._consulta.abrirFiltro();
      await this._orchestrator._consulta.definirDatas();
      await this._orchestrator._consulta.clicarAtualizar();
      await this._page.waitForTimeout(1000);
    } catch (err) {
      logAviso(`Worker ${this._workerId}: falha na recarga periodica F1`, {
        worker: this._workerId,
        erro: err.message,
      });
    }
  }

  async _sleep(ms) {
    await new Promise(r => setTimeout(r, ms));
  }

  async _salvarDiagnosticoErro(nomeArquivo, contexto) {
    try {
      const dir = join(process.cwd(), 'logs', 'erros');
      await mkdir(dir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const prefix = this._workerId + '_' + nomeArquivo + '_' + timestamp;

      const screenshot = await this._page.screenshot({ fullPage: true }).catch(() => null);
      if (screenshot) {
        await writeFile(join(dir, prefix + '.png'), screenshot);
      }

      const html = await this._page.content().catch(() => null);
      if (html) {
        await writeFile(join(dir, prefix + '.html'), html);
      }

      logInfo('Diagnostico salvo: ' + prefix, {
        worker: this._workerId,
        carga: nomeArquivo,
        contexto,
      });
    } catch (err) {
      logAviso('Falha ao salvar diagnostico: ' + err.message, {
        worker: this._workerId,
        carga: nomeArquivo,
      });
    }
  }

  desativar() {
    if (this._state === ESTADOS.PROCESSING || this._state === ESTADOS.SEARCHING) {
      logAviso(`Worker ${this._workerId}: desativação adiada (em processamento)`, {
        worker: this._workerId,
        carga: this._cargaAtual?.nomeArquivo,
      });
      return false;
    }
    this._setEstado(ESTADOS.DISABLED);
    return true;
  }

  reativar() {
    if (this._state === ESTADOS.DISABLED) {
      this._setEstado(ESTADOS.IDLE);
      return true;
    }
    return false;
  }

  parar() {
    this._deveParar = true;
    this._pararHeartbeat();
    this._pararWatchdog();
  }

  async destruir() {
    this._pararHeartbeat();
    this._pararWatchdog();
    this._deveParar = true;
    try {
      if (this._page && !this._page.isClosed()) {
        await this._page.close();
      }
    } catch { }
  }
}
