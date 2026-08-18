import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaceController } from '../../../src/metrics/pace-controller.js';
import { MetricsCollector } from '../../../src/metrics/collector.js';

vi.mock('../../../src/logger.js', () => ({
  logInfo: vi.fn(),
  logAviso: vi.fn(),
  logErro: vi.fn(),
  logSucesso: vi.fn(),
  logMetrica: vi.fn(),
  logDecision: vi.fn(),
  logEstado: vi.fn(),
}));

describe('PaceController', () => {
  let paceController;
  let metrics;
  let mockPool;

  beforeEach(() => {
    metrics = new MetricsCollector();
    mockPool = {
      metrics,
      targetWorkers: 4,
      originalTarget: 4,
      _workers: new Map(),
      desativarWorker: vi.fn().mockReturnValue(true),
      reativarWorker: vi.fn().mockReturnValue(true),
      obterWorkerDesativado: vi.fn().mockReturnValue(null),
      obterWorkersDisponiveis: vi.fn().mockReturnValue(['ABA01', 'ABA02']),
      ajustarTarget: vi.fn(),
    };
    paceController = new PaceController(mockPool);
  });

  describe('constructor', () => {
    it('deve inicializar com baseline 0', () => {
      expect(paceController.baseline).toBe(0);
    });
  });

  describe('registrarCarga', () => {
    it('deve coletar baseline nas primeiras 5 cargas', () => {
      for (let i = 0; i < 5; i++) {
        metrics.registrarWorker(`W${i}`);
        metrics.registrarCargaConcluida(`W${i}`, 60000, true);
        paceController.registrarCarga(60000);
      }
      expect(paceController.baseline).toBeGreaterThan(0);
    });

    it('deve detectar degradação acima de 1.5min', () => {
      for (let i = 0; i < 5; i++) {
        metrics.registrarWorker(`W${i}`);
        metrics.registrarCargaConcluida(`W${i}`, 60000, true);
        paceController.registrarCarga(60000);
      }
      const baselineAntes = paceController.baseline;
      for (let i = 0; i < 5; i++) {
        metrics.registrarCargaConcluida(`W${i}`, 150000, true);
        paceController.registrarCarga(150000);
      }
      expect(mockPool.desativarWorker).toHaveBeenCalled();
    });

    it('não deve reduzir se dentro do threshold', () => {
      for (let i = 0; i < 5; i++) {
        metrics.registrarWorker(`W${i}`);
        metrics.registrarCargaConcluida(`W${i}`, 60000, true);
        paceController.registrarCarga(60000);
      }
      mockPool.desativarWorker.mockClear();
      for (let i = 0; i < 3; i++) {
        metrics.registrarCargaConcluida(`W${i}`, 65000, true);
        paceController.registrarCarga(65000);
      }
      expect(mockPool.desativarWorker).not.toHaveBeenCalled();
    });
  });

  describe('verificarMelhoria', () => {
    it('deve reativar worker se performance melhorou', () => {
      paceController._emEstabilizacao = true;
      paceController._baseline = 60000;
      metrics.registrarWorker('W1');
      metrics.registrarWorker('W2');
      metrics.registrarWorker('W3');
      mockPool.targetWorkers = 3;
      mockPool.obterWorkerDesativado.mockReturnValue({ workerId: 'ABA04' });

      for (let i = 0; i < 5; i++) {
        metrics.registrarCargaConcluida('W1', 62000, true);
      }

      paceController.verificarMelhoria();
      expect(mockPool.reativarWorker).toHaveBeenCalledWith('ABA04');
      expect(mockPool.ajustarTarget).toHaveBeenCalledWith(4);
    });

    it('não deve fazer nada se não está em estabilização', () => {
      paceController._emEstabilizacao = false;
      paceController.verificarMelhoria();
      expect(mockPool.reativarWorker).not.toHaveBeenCalled();
    });
  });

  describe('logStatus', () => {
    it('deve logar status sem erros', () => {
      expect(() => paceController.logStatus()).not.toThrow();
    });
  });
});
