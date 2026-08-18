import { logInfo, logAviso, logErro, logSucesso } from '../logger.js';
import { TabWorker, ESTADOS } from './tab-worker.js';
import { SharedQueueManager } from './shared-queue.js';
import { PipelineOrchestrator } from '../pipeline/pipeline-orchestrator.js';
import { MetricsCollector } from '../metrics/collector.js';
import { NUM_WORKERS_F1, NUM_WORKERS_F23 } from '../config.js';

export class WorkerPool {
  constructor(context) {
    this._context = context;
    this._queueManager = new SharedQueueManager();
    this._workers = new Map();
    this._metrics = new MetricsCollector();
    this._workersAtivos = 0;
    this._executando = false;
    this._sheets = null;
    this._targetWorkers = NUM_WORKERS_F1 + NUM_WORKERS_F23;
    this._originalTarget = NUM_WORKERS_F1 + NUM_WORKERS_F23;
    this._pipeline = null;
  }

  get metrics() { return this._metrics; }
  get queueManager() { return this._queueManager; }
  get targetWorkers() { return this._targetWorkers; }
  get originalTarget() { return this._originalTarget; }
  get workersAtivos() { return this._workersAtivos; }
  get pipeline() { return this._pipeline; }

  obterWorkersDisponiveis() {
    return Array.from(this._workers.entries())
      .filter(([id, w]) => !w.isDisabled && w.isIdle)
      .map(([id, w]) => id);
  }

  desativarWorker(workerId) {
    const worker = this._workers.get(workerId);
    if (worker && worker.desativar()) {
      this._workersAtivos--;
      return true;
    }
    return false;
  }

  reativarWorker(workerId) {
    const worker = this._workers.get(workerId);
    if (worker && worker.reativar()) {
      this._workersAtivos++;
      return true;
    }
    return false;
  }

  ajustarTarget(n) {
    this._targetWorkers = Math.max(1, n);
  }

  obterWorkerDesativado() {
    for (const [id, w] of this._workers) {
      if (w.isDisabled) return { workerId: id };
    }
    return null;
  }

  async inicializar() {
    const total = NUM_WORKERS_F1 + NUM_WORKERS_F23;
    logInfo(`Inicializando pool com ${total} workers (${NUM_WORKERS_F1} F1 + ${NUM_WORKERS_F23} F2/F3)`);

    for (let i = 1; i <= NUM_WORKERS_F1; i++) {
      const workerId = `F1-${String(i).padStart(2, '0')}`;
      await this._criarWorker(workerId, 'f1');
    }
    for (let i = 1; i <= NUM_WORKERS_F23; i++) {
      const workerId = `F23-${String(i).padStart(2, '0')}`;
      await this._criarWorker(workerId, 'f23');
    }

    logInfo(`${this._workersAtivos} workers inicializados`);
  }

  async _criarWorker(workerId, workerType = 'f23') {
    let worker;
    if (workerType === 'f23') {
      const storageState = await this._context.storageState();
      const browser = this._context.browser();
      const ctx = await browser.newContext({ storageState });
      worker = new TabWorker(ctx, workerId, this._metrics, workerType);
    } else {
      worker = new TabWorker(this._context, workerId, this._metrics, workerType);
    }
    this._metrics.registrarWorker(workerId);
    await worker.inicializar();
    this._workers.set(workerId, worker);
    this._workersAtivos++;
    logInfo(`Worker ${workerId} criado e inicializado`);
    return worker;
  }

  async aguardarFinalizacao() {
    this._executando = true;

    logInfo('Iniciando pipeline concorrente', {
      workers: this._workersAtivos,
      fila1: this._queueManager.fila1Tamanho,
      fila2: this._queueManager.fila2Tamanho,
      fila3: this._queueManager.fila3Tamanho,
    });

    this._pipeline = new PipelineOrchestrator(this._queueManager, this, this._sheets);
    await this._pipeline.iniciar();

    const promises = [];
    for (const [workerId, worker] of this._workers) {
      worker.setPipelineOrchestrator(this._pipeline);
      logInfo(`Disparando loop do worker ${workerId}`);
      promises.push(this._executarWorker(worker));
    }

    logInfo(`${promises.length} worker loops disparados`);
    await Promise.all(promises);
  }

  async executar(sheets) {
    this._sheets = sheets;
    this._executando = true;

    logInfo('Iniciando pipeline concorrente', {
      workers: this._workersAtivos,
      filaInicial: this._queueManager.fila1Tamanho,
    });

    this._pipeline = new PipelineOrchestrator(this._queueManager, this, this._sheets);
    await this._pipeline.iniciar();

    const promises = [];
    for (const [workerId, worker] of this._workers) {
      worker.setPipelineOrchestrator(this._pipeline);
      logInfo(`Disparando loop do worker ${workerId}`);
      promises.push(this._executarWorker(worker));
    }

    logInfo(`${promises.length} worker loops disparados`);
    await Promise.all(promises);
  }

  async _executarWorker(worker) {
    logInfo(`Worker ${worker.workerId}: loop iniciado`, {
      estado: worker.state,
      executando: this._executando,
    });

    while (this._executando && !worker._deveParar) {
      if (worker.isDisabled) {
        await worker._sleep(1000);
        continue;
      }

      if (worker.state === ESTADOS.RECOVERING) {
        logAviso(`Worker ${worker.workerId}: em recuperacao, aguardando`, {
          worker: worker.workerId,
          carga: worker._cargaAtual?.nomeArquivo,
        });
        await worker._sleep(2000);
        continue;
      }

      if (worker.isFailed) {
        logAviso(`Worker ${worker.workerId} em estado failed, tentando recriar`);
        try {
          await worker.destruir();
          if (worker._context && worker._context !== this._context) {
            try { await worker._context.close(); } catch {}
          }
        } catch { }
        this._workers.delete(worker.workerId);
        this._workersAtivos--;

        try {
          const novoWorker = await this._criarWorker(worker.workerId);
          novoWorker.setPipelineOrchestrator(this._pipeline);
          worker = novoWorker;
          continue;
        } catch (err) {
          logErro(`Worker ${worker.workerId}: falha ao recriar`, {
            worker: worker.workerId,
            erro: err.message,
          });
          break;
        }
      }

      const continuar = await this._pipeline.tick(worker);
      if (!continuar) {
        break;
      }
    }

    logInfo(`Worker ${worker.workerId} encerrado`);
  }

  async parar() {
    this._executando = false;
    if (this._pipeline) {
      await this._pipeline.parar();
    }
    for (const [id, worker] of this._workers) {
      worker.parar();
    }
  }

  async destruir() {
    this._executando = false;
    for (const [id, worker] of this._workers) {
      await worker.destruir();
      if (worker._context && worker._context !== this._context) {
        try { await worker._context.close(); } catch {}
      }
    }
    this._workers.clear();
  }
}
