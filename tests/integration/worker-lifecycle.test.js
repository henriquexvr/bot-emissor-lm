import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logInfo: vi.fn(),
  logAviso: vi.fn(),
  logErro: vi.fn(),
  logSucesso: vi.fn(),
  logMetrica: vi.fn(),
  logDecision: vi.fn(),
  logEstado: vi.fn(),
}));

vi.mock('../../src/workers/tab-worker.js', () => {
  let counter = 0;
  return {
    TabWorker: vi.fn(function MockTabWorker() {
      counter++;
      const id = `ABA${String(counter).padStart(2, '0')}`;
      return {
        workerId: id,
        state: 'idle',
        isIdle: true,
        isProcessing: false,
        isDisabled: false,
        isFailed: false,
        _deveParar: false,
        _cargaAtual: null,
        _sleep: vi.fn().mockResolvedValue(undefined),
        setPipelineOrchestrator: vi.fn(),
        inicializar: vi.fn().mockResolvedValue(undefined),
        executarBlocoPreenchimento: vi.fn().mockImplementation(async (blocos, qm) => {
          for (const carga of blocos) {
            await qm.moverParaFila2(carga);
          }
        }),
        executarBlocoEmissao: vi.fn().mockImplementation(async (blocos, qm) => {
          for (const carga of blocos) {
            await qm.moverParaFila3(carga);
          }
        }),
        executarBlocoVerificacao: vi.fn().mockImplementation(async (blocos) => {
          for (const carga of blocos) {
            carga.concluir();
          }
        }),
        executarCarga: vi.fn().mockImplementation(async (carga) => {
          await new Promise(r => setTimeout(r, 10));
          return { sucesso: true, resultado: 'ok' };
        }),
        desativar: vi.fn().mockReturnValue(true),
        reativar: vi.fn().mockReturnValue(true),
        parar: vi.fn(),
        destruir: vi.fn().mockResolvedValue(undefined),
      };
    }),
    ESTADOS: { IDLE: 'idle', PROCESSING: 'processing', DISABLED: 'disabled', FAILED: 'failed' },
  };
});

vi.mock('../../src/pipeline/pipeline-orchestrator.js', () => ({
  PipelineOrchestrator: vi.fn(function MockPipeline() {
    this.iniciar = vi.fn().mockResolvedValue(undefined);
    this.parar = vi.fn().mockResolvedValue(undefined);
    this.tick = vi.fn().mockResolvedValue(false);
    this.fila1WorkersAtivos = 0;
    this.fila2WorkersAtivos = 0;
    this.fila3WorkersAtivos = 0;
  }),
}));

import { WorkerPool } from '../../src/workers/worker-pool.js';
import { cargasMock } from '../fixtures/cargas.js';

describe('WorkerPool - Integração', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('gerenciamento de filas', () => {
    it('deve adicionar cargas a Fila 1 corretamente', async () => {
      const pool = new WorkerPool({});
      const adicionadas = await pool.queueManager.adicionarFila1(cargasMock.slice(0, 3));
      expect(adicionadas).toBe(3);
      expect(pool.queueManager.fila1Tamanho).toBe(3);
    });

    it('não deve duplicar cargas na Fila 1', async () => {
      const pool = new WorkerPool({});
      await pool.queueManager.adicionarFila1(cargasMock.slice(0, 3));
      const segundas = await pool.queueManager.adicionarFila1(cargasMock.slice(0, 3));
      expect(segundas).toBe(0);
      expect(pool.queueManager.fila1Tamanho).toBe(3);
    });

    it('deve mover carga da Fila 1 para Fila 2', async () => {
      const pool = new WorkerPool({});
      await pool.queueManager.adicionarFila1([cargasMock[0]]);
      const carga = await pool.queueManager.pegarProximaFila1();
      expect(carga).not.toBeNull();
      expect(carga.nomeArquivo).toBe(cargasMock[0].nomeArquivo);
      await pool.queueManager.moverParaFila2(carga);
      expect(pool.queueManager.fila2Tamanho).toBe(1);
    });

    it('deve mover carga da Fila 2 para Fila 3', async () => {
      const pool = new WorkerPool({});
      await pool.queueManager.adicionarFila1([cargasMock[0]]);
      const carga = await pool.queueManager.pegarProximaFila1();
      await pool.queueManager.moverParaFila2(carga);
      const daFila2 = await pool.queueManager.pegarProximaFila2();
      expect(daFila2).not.toBeNull();
      expect(daFila2.nomeArquivo).toBe(cargasMock[0].nomeArquivo);
      await pool.queueManager.moverParaFila3(daFila2);
      expect(pool.queueManager.fila3Tamanho).toBe(1);
    });

    it('deve processar pipeline completo (F1 → F2 → F3)', async () => {
      const pool = new WorkerPool({});
      await pool.queueManager.adicionarFila1(cargasMock.slice(0, 2));

      const carga1 = await pool.queueManager.pegarProximaFila1();
      await pool.queueManager.moverParaFila2(carga1);
      const carga2 = await pool.queueManager.pegarProximaFila1();
      await pool.queueManager.moverParaFila2(carga2);

      expect(pool.queueManager.fila1Tamanho).toBe(0);
      expect(pool.queueManager.fila2Tamanho).toBe(2);

      const e1 = await pool.queueManager.pegarProximaFila2();
      await pool.queueManager.moverParaFila3(e1);
      const e2 = await pool.queueManager.pegarProximaFila2();
      await pool.queueManager.moverParaFila3(e2);

      expect(pool.queueManager.fila2Tamanho).toBe(0);
      expect(pool.queueManager.fila3Tamanho).toBe(2);
      expect(pool.queueManager.totalProcessadas).toBe(2);
    });

    it('deve informar que esta vazia corretamente', async () => {
      const pool = new WorkerPool({});
      expect(pool.queueManager.estaVazia()).toBe(true);
      await pool.queueManager.adicionarFila1([cargasMock[0]]);
      expect(pool.queueManager.estaVazia()).toBe(false);
    });
  });
});
