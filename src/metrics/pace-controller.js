import { logInfo, logAviso, logMetrica } from '../logger.js';
import {
  PACE_DEGRADATION_THRESHOLD_MS,
  PACE_STABILIZATION_WAIT_MS,
  MIN_CONCURRENT_PAGES,
} from '../config.js';

export class PaceController {
  constructor(pool) {
    this._pool = pool;
    this._metrics = pool ? pool.metrics : null;
    this._baseline = 0;
    this._cargasParaBaseline = 5;
    this._cargasColetadas = 0;
    this._emEstabilizacao = false;
    this._timestampUltimaReducao = 0;
    this._ultimaReducao = 0;
    this._duracoesRecentes = [];
    this._janelaMedia = 5;
    this._degradacoesConsecutivas = 0;
    this._minDegradacoesParaReducao = 3;
    this._ultimoLogStatus = 0;
    this._logStatusIntervalo = 60000;
  }

  get baseline() { return this._baseline; }
  get estaEstavel() { return !this._emEstabilizacao; }

  registrarCarga(duracaoMs, resultado = null) {
    const isJaFinalizada = resultado === 'ja_finalizada';
    this._cargasColetadas++;

    if (!isJaFinalizada) {
      this._duracoesRecentes.push(duracaoMs);
      if (this._duracoesRecentes.length > this._janelaMedia * 2) {
        this._duracoesRecentes = this._duracoesRecentes.slice(-this._janelaMedia * 2);
      }
    }

    if (this._cargasColetadas <= this._cargasParaBaseline && !isJaFinalizada) {
      this._atualizarBaseline();
      return;
    }

    if (this._baseline === 0 && !isJaFinalizada) {
      this._atualizarBaseline();
    }

    if (this._emEstabilizacao) {
      const elapsed = Date.now() - this._timestampUltimaReducao;
      if (elapsed >= PACE_STABILIZATION_WAIT_MS) {
        this._emEstabilizacao = false;
        this._degradacoesConsecutivas = 0;
        logInfo('PaceController: período de estabilização concluído');
      }
      return;
    }

    if (!isJaFinalizada) {
      this._verificarDegradacao(duracaoMs);
    }

    this._logStatusPeriodico();
  }

  _atualizarBaseline() {
    const duracoes = this._duracoesRecentes.slice(-this._janelaMedia);
    if (duracoes.length === 0) return;

    const media = duracoes.reduce((a, b) => a + b, 0) / duracoes.length;

    if (this._baseline === 0) {
      this._baseline = media;
      logMetrica('PaceController: baseline estabelecido', {
        baseline: `${(this._baseline / 1000).toFixed(1)}s`,
        amostras: duracoes.length,
        worker: 'system',
      });
    } else {
      const novoBaseline = this._baseline * 0.7 + media * 0.3;
      if (Math.abs(novoBaseline - this._baseline) > 5000) {
        this._baseline = novoBaseline;
      }
    }
  }

  _verificarDegradacao(duracaoMs) {
    if (this._baseline === 0) return;

    const degradacao = duracaoMs - this._baseline;

    if (degradacao >= PACE_DEGRADATION_THRESHOLD_MS) {
      this._degradacoesConsecutivas++;
      logAviso('PaceController: degradação detectada', {
        baseline: `${(this._baseline / 1000).toFixed(1)}s`,
        atual: `${(duracaoMs / 1000).toFixed(1)}s`,
        degradacao: `+${(degradacao / 1000).toFixed(1)}s`,
        consecutivas: `${this._degradacoesConsecutivas}/${this._minDegradacoesParaReducao}`,
      });

      if (this._degradacoesConsecutivas >= this._minDegradacoesParaReducao) {
        this._reduzirWorkers();
      }
    } else {
      this._degradacoesConsecutivas = 0;
    }
  }

  _reduzirWorkers() {
    if (!this._pool || typeof this._pool.targetWorkers === 'undefined') return;

    const targetAtual = this._pool.targetWorkers;
    if (targetAtual <= MIN_CONCURRENT_PAGES) {
      logAviso('PaceController: já no mínimo de workers', {
        atual: targetAtual,
      });
      return;
    }

    let workersDisponiveis = [];
    try {
      workersDisponiveis = this._pool.obterWorkersDisponiveis();
    } catch { return; }

    if (workersDisponiveis.length === 0) {
      logAviso('PaceController: nenhum worker disponível para desativar');
      return;
    }

    const workerParaDesativar = workersDisponiveis[workersDisponiveis.length - 1];
    let desativado = false;
    try {
      desativado = this._pool.desativarWorker(workerParaDesativar);
    } catch { return; }

    if (desativado) {
      try { this._pool.ajustarTarget(targetAtual - 1); } catch { }
      this._emEstabilizacao = true;
      this._timestampUltimaReducao = Date.now();
      this._ultimaReducao = Date.now();
      this._degradacoesConsecutivas = 0;

      logAviso('PaceController: redução automática de workers', {
        de: targetAtual,
        para: targetAtual - 1,
        workerDesativado: workerParaDesativar,
      });

      if (this._metrics && typeof this._metrics.logResumo === 'function') {
        this._metrics.logResumo();
      }
    }
  }

  verificarMelhoria() {
    if (!this._emEstabilizacao) return;
    if (!this._pool) return;

    let targetWorkers, originalTarget;
    try {
      targetWorkers = this._pool.targetWorkers;
      originalTarget = this._pool.originalTarget;
    } catch { return; }

    if (targetWorkers >= originalTarget) return;

    let tempoRecente = 0;
    try {
      tempoRecente = this._metrics.obterTempoMedioRecente(5);
    } catch { return; }
    if (tempoRecente === 0) return;

    if (this._baseline > 0 && tempoRecente <= this._baseline * 1.1) {
      const targetAtual = targetWorkers;
      let disabled;
      try { disabled = this._pool.obterWorkerDesativado(); } catch { return; }

      if (disabled) {
        try {
          this._pool.reativarWorker(disabled.workerId);
          this._pool.ajustarTarget(targetAtual + 1);
        } catch { return; }
        logInfo('PaceController: performance recuperada, reativando worker', {
          worker: disabled.workerId,
          novoTarget: targetAtual + 1,
        });
      }
    }
  }

  _logStatusPeriodico() {
    const agora = Date.now();
    if (agora - this._ultimoLogStatus < this._logStatusIntervalo) return;
    this._ultimoLogStatus = agora;
    this.logStatus();
  }

  logStatus() {
    let tempoRecente = 0;
    try { tempoRecente = this._metrics.obterTempoMedioRecente(); } catch { }

    let workersAtivos = 0;
    let targetWorkers = 0;
    let workersFila1 = 0;
    let workersFila2 = 0;
    let workersFila3 = 0;
    let fila1Size = 0;
    let fila2Size = 0;
    let fila3Size = 0;
    let throughput = 0;

    if (this._pool) {
      try { workersAtivos = this._pool.workersAtivos; } catch { }
      try { targetWorkers = this._pool.targetWorkers; } catch { }
      try {
        const pipeline = this._pool.pipeline;
        if (pipeline) {
          workersFila1 = pipeline.fila1WorkersAtivos;
          workersFila2 = pipeline.fila2WorkersAtivos;
          workersFila3 = pipeline.fila3WorkersAtivos;
        }
      } catch { }
      try {
        const qm = this._pool.queueManager;
        if (qm) {
          fila1Size = qm.fila1Tamanho;
          fila2Size = qm.fila2Tamanho;
          fila3Size = qm.fila3Tamanho;
        }
      } catch { }
      try { throughput = this._metrics.obterThroughput(); } catch { }
    }

    logMetrica('PaceController: status do pipeline', {
      tempoMedioRecente: tempoRecente > 0 ? `${(tempoRecente / 1000).toFixed(1)}s` : 'N/A',
      throughput: `${throughput.toFixed(2)} cargas/min`,
      workersAtivos,
      targetWorkers,
      workersF1: workersFila1,
      workersF2: workersFila2,
      workersF3: workersFila3,
      fila1: fila1Size,
      fila2: fila2Size,
      fila3: fila3Size,
      baseline: this._baseline > 0 ? `${(this._baseline / 1000).toFixed(1)}s` : 'N/A',
    });
  }
}
