import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerPool } from '../../../src/workers/worker-pool.js';

vi.mock('../../../src/logger.js', () => ({
  logInfo: vi.fn(),
  logAviso: vi.fn(),
  logErro: vi.fn(),
  logSucesso: vi.fn(),
  logMetrica: vi.fn(),
  logDecision: vi.fn(),
  logEstado: vi.fn(),
}));

const criarWorkerMock = (id) => ({
  workerId: id,
  state: 'idle',
  isIdle: true,
  isProcessing: false,
  isDisabled: false,
  isFailed: false,
  _deveParar: false,
  setPipelineOrchestrator: vi.fn(),
  _sleep: vi.fn().mockResolvedValue(undefined),
  inicializar: vi.fn().mockResolvedValue(undefined),
  desativar: vi.fn().mockReturnValue(true),
  reativar: vi.fn().mockReturnValue(true),
  parar: vi.fn(),
  destruir: vi.fn().mockResolvedValue(undefined),
  executarBlocoPreenchimento: vi.fn().mockResolvedValue(undefined),
  executarBlocoEmissao: vi.fn().mockResolvedValue(undefined),
  executarBlocoVerificacao: vi.fn().mockResolvedValue(undefined),
});

vi.mock('../../../src/workers/tab-worker.js', () => {
  let counter = 0;
  return {
    TabWorker: vi.fn(function MockTabWorker() {
      counter++;
      return criarWorkerMock(`ABA${String(counter).padStart(2, '0')}`);
    }),
    ESTADOS: { IDLE: 'idle', PROCESSING: 'processing', DISABLED: 'disabled', FAILED: 'failed' },
  };
});

vi.mock('../../../src/pipeline/pipeline-orchestrator.js', () => ({
  PipelineOrchestrator: vi.fn(function MockPipeline() {
    this.iniciar = vi.fn().mockResolvedValue(undefined);
    this.parar = vi.fn().mockResolvedValue(undefined);
    this.tick = vi.fn().mockResolvedValue(false);
    this.fila1WorkersAtivos = 0;
    this.fila2WorkersAtivos = 0;
    this.fila3WorkersAtivos = 0;
  }),
}));

describe('WorkerPool', () => {
  let pool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new WorkerPool({});
  });

  describe('constructor', () => {
    it('deve inicializar com target correto', () => {
      expect(pool.targetWorkers).toBe(5);
      expect(pool.originalTarget).toBe(5);
    });

    it('deve inicializar com queueManager', () => {
      expect(pool.queueManager).toBeDefined();
      expect(pool.queueManager.fila1Tamanho).toBe(0);
    });
  });

  describe('obterWorkersDisponiveis', () => {
    it('deve retornar array vazio inicialmente', () => {
      const disponiveis = pool.obterWorkersDisponiveis();
      expect(disponiveis).toEqual([]);
    });
  });

  describe('ajustarTarget', () => {
    it('deve ajustar target', () => {
      pool.ajustarTarget(3);
      expect(pool.targetWorkers).toBe(3);
    });

    it('não deve ajustar abaixo de 1', () => {
      pool.ajustarTarget(0);
      expect(pool.targetWorkers).toBe(1);
    });
  });

  describe('obterWorkerDesativado', () => {
    it('deve retornar null se nenhum desativado', () => {
      expect(pool.obterWorkerDesativado()).toBeNull();
    });
  });

  describe('parar', () => {
    it('deve parar pool', async () => {
      await pool.parar();
      expect(pool._executando).toBe(false);
    });
  });

  describe('destruir', () => {
    it('destruir pool', async () => {
      await pool.destruir();
      expect(pool._workers.size).toBe(0);
    });
  });
});
