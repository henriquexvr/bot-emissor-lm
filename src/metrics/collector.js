import { logInfo } from '../logger.js';

export class MetricsCollector {
  constructor() {
    this._workers = new Map();
    this._global = {
      totalCargasProcessadas: 0,
      totalSucesso: 0,
      totalFalha: 0,
      tempoTotalProcessamento: 0,
      inicioColeta: Date.now(),
    };
  }

  registrarWorker(workerId) {
    this._workers.set(workerId, {
      workerId,
      cargasConcluidas: 0,
      tempoTotalCarga: 0,
      erros: 0,
      reinicializacoes: 0,
      duracoes: [],
      inicioAtividade: Date.now(),
    });
  }

  removerWorker(workerId) {
    this._workers.delete(workerId);
  }

  registrarCargaConcluida(workerId, duracaoMs, sucesso) {
    const worker = this._workers.get(workerId);
    if (!worker) return;

    worker.cargasConcluidas++;
    worker.tempoTotalCarga += duracaoMs;
    worker.duracoes.push(duracaoMs);

    this._global.totalCargasProcessadas++;
    this._global.tempoTotalProcessamento += duracaoMs;

    if (sucesso) {
      this._global.totalSucesso++;
    } else {
      this._global.totalFalha++;
      worker.erros++;
    }
  }

  registrarReinicializacao(workerId) {
    const worker = this._workers.get(workerId);
    if (worker) worker.reinicializacoes++;
  }

  obterTempoMedioWorker(workerId) {
    const worker = this._workers.get(workerId);
    if (!worker || worker.cargasConcluidas === 0) return 0;
    return worker.tempoTotalCarga / worker.cargasConcluidas;
  }

  obterTempoMedioGlobal() {
    if (this._global.totalCargasProcessadas === 0) return 0;
    return this._global.tempoTotalProcessamento / this._global.totalCargasProcessadas;
  }

  obterTempoMedioRecente(janela = 10) {
    const todasDuracoes = [];
    for (const worker of this._workers.values()) {
      const recentes = worker.duracoes.slice(-janela);
      todasDuracoes.push(...recentes);
    }
    if (todasDuracoes.length === 0) return 0;
    return todasDuracoes.reduce((a, b) => a + b, 0) / todasDuracoes.length;
  }

  obterThroughput() {
    const elapsed = (Date.now() - this._global.inicioColeta) / 60000;
    if (elapsed <= 0) return 0;
    return this._global.totalCargasProcessadas / elapsed;
  }

  obterResumo() {
    const workersAtivos = this._workers.size;
    const tempoMedioGlobal = this.obterTempoMedioGlobal();
    const tempoMedioRecente = this.obterTempoMedioRecente();
    const throughput = this.obterThroughput();

    const detalhesWorkers = [];
    for (const [id, w] of this._workers) {
      detalhesWorkers.push({
        workerId: id,
        cargasConcluidas: w.cargasConcluidas,
        tempoMedio: w.cargasConcluidas > 0
          ? (w.tempoTotalCarga / w.cargasConcluidas / 1000).toFixed(1) + 's'
          : 'N/A',
        erros: w.erros,
        reinicializacoes: w.reinicializacoes,
      });
    }

    return {
      workersAtivos,
      totalProcessadas: this._global.totalCargasProcessadas,
      sucesso: this._global.totalSucesso,
      falha: this._global.totalFalha,
      tempoMedioGlobal: (tempoMedioGlobal / 1000).toFixed(1) + 's',
      tempoMedioRecente: (tempoMedioRecente / 1000).toFixed(1) + 's',
      throughput: throughput.toFixed(2) + ' cargas/min',
      detalhesWorkers,
    };
  }

  logResumo() {
    const resumo = this.obterResumo();
    logInfo('Métricas globais', {
      workersAtivos: resumo.workersAtivos,
      totalProcessadas: resumo.totalProcessadas,
      sucesso: resumo.sucesso,
      falha: resumo.falha,
      tempoMedioGlobal: resumo.tempoMedioGlobal,
      tempoMedioRecente: resumo.tempoMedioRecente,
      throughput: resumo.throughput,
    });
    for (const w of resumo.detalhesWorkers) {
      logInfo(`Worker ${w.workerId}`, {
        cargas: w.cargasConcluidas,
        tempoMedio: w.tempoMedio,
        erros: w.erros,
        reinicializacoes: w.reinicializacoes,
      });
    }
  }
}
