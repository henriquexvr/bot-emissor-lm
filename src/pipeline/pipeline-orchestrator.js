import { logInfo, logAviso, logErro, logSucesso } from '../logger.js';
import { BATCH_SIZE, LOOP_INTERVALO_MS } from '../config.js';

export class PipelineOrchestrator {
  constructor(queueManager, workerPool, sheetsRepository) {
    this._queue = queueManager;
    this._pool = workerPool;
    this._sheets = sheetsRepository;
    this._executando = false;
    this._batchAtual = 0;
    this._workersFila1 = 0;
    this._workersFila2 = 0;
    this._workersFila3 = 0;
  }

  get fila1WorkersAtivos() { return this._workersFila1; }
  get fila2WorkersAtivos() { return this._workersFila2; }
  get fila3WorkersAtivos() { return this._workersFila3; }

  async iniciar() {
    this._executando = true;
    logInfo('PipelineOrchestrator: iniciado', {
      batchSize: BATCH_SIZE,
      fila1: this._queue.fila1Tamanho,
      fila2: this._queue.fila2Tamanho,
      fila3: this._queue.fila3Tamanho,
    });
  }

  async parar() {
    this._executando = false;
  }

  async tick(worker) {
    if (!this._executando || worker.isDisabled || worker.isFailed) return false;

    const f1 = this._queue.fila1Tamanho;
    const f2 = this._queue.fila2Tamanho;
    const f3 = this._queue.fila3Tamanho;

    if (f1 === 0 && f2 === 0 && f3 === 0) {
      if (this._workersFila1 === 0 && this._workersFila2 === 0 && this._workersFila3 === 0) {
        logSucesso('Pipeline: todas as filas vazias e workers ociosos, encerrando');
        this._executando = false;
        return false;
      }
      await worker._sleep(2000);
      return true;
    }

    const processou = worker.workerType === 'f1'
      ? await this._tentarProcessarFila1(worker)
      : await this._tentarProcessarFila2(worker)
        || await this._tentarProcessarFila3(worker);

    if (!processou) {
      await worker._sleep(1000);
    }

    return true;
  }

  async _tentarProcessarFila1(worker) {
    const f1 = this._queue.fila1Tamanho;
    if (f1 === 0) return null;

    const bloco = await this._queue.pegarBlocoFila1(BATCH_SIZE);
    if (bloco.length === 0) return null;

    this._workersFila1++;
    logInfo(`Pipeline/Worker ${worker.workerId}: Fila 1 processando lote de ${bloco.length} carga(s)`, {
      fila1: this._queue.fila1Tamanho,
      workersF1: this._workersFila1,
    });

    try {
      await worker.executarBlocoPreenchimento(bloco, this._queue);
    } catch (err) {
      logErro(`Pipeline/Worker ${worker.workerId}: erro no bloco F1`, { erro: err.message });
    } finally {
      this._workersFila1--;
    }

    return true;
  }

  async _tentarProcessarFila2(worker) {
    const carga = await this._queue.pegarProximaFila2();
    if (!carga) return null;

    this._workersFila2++;
    logInfo(`Pipeline/Worker ${worker.workerId}: Fila 2 emitindo`, {
      carga: carga.nomeArquivo,
      fila2: this._queue.fila2Tamanho,
      workersF2: this._workersFila2,
    });

    try {
      await worker.executarBlocoEmissao([carga], this._queue);
    } catch (err) {
      logErro(`Pipeline/Worker ${worker.workerId}: erro na emissao F2`, {
        carga: carga.nomeArquivo,
        erro: err.message,
      });
      await this._queue.devolverParaFila2(carga);
    } finally {
      this._workersFila2--;
    }

    return true;
  }

  async _tentarProcessarFila3(worker) {
    const carga = await this._queue.pegarProximaFila3();
    if (!carga) return null;

    this._workersFila3++;
    logInfo(`Pipeline/Worker ${worker.workerId}: Fila 3 validando`, {
      carga: carga.nomeArquivo,
      fila3: this._queue.fila3Tamanho,
      workersF3: this._workersFila3,
    });

    try {
      await worker.executarBlocoVerificacao([carga], this._queue);
    } catch (err) {
      logErro(`Pipeline/Worker ${worker.workerId}: erro na validacao F3`, {
        carga: carga.nomeArquivo,
        erro: err.message,
      });
      await this._queue.devolverParaFila3(carga);
    } finally {
      this._workersFila3--;
    }

    return true;
  }

  async _sleep(ms) {
    await new Promise(r => setTimeout(r, ms));
  }
}
