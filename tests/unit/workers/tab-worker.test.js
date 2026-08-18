import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.js', () => ({
  logInfo: vi.fn(),
  logAviso: vi.fn(),
  logErro: vi.fn(),
  logSucesso: vi.fn(),
  logMetrica: vi.fn(),
  logDecision: vi.fn(),
  logEstado: vi.fn(),
}));

vi.mock('../../../src/orchestrator.js', () => ({
  Orchestrator: vi.fn(function MockOrchestrator() {
    this._consulta = {
      navegarParaConsulta: vi.fn().mockResolvedValue(undefined),
      abrirFiltro: vi.fn().mockResolvedValue(undefined),
      definirDatas: vi.fn().mockResolvedValue(undefined),
    };
    this.executarFluxo = vi.fn().mockResolvedValue('ok');
  }),
}));

vi.mock('../../../src/workers/recovery.js', () => ({
  RecoveryManager: vi.fn(function MockRecovery() {
    this.recuperar = vi.fn().mockResolvedValue({ sucesso: true });
    this.recarregarAba = vi.fn().mockResolvedValue(true);
    this.tentarRecuperacaoLocal = vi.fn().mockResolvedValue(true);
  }),
}));

vi.mock('../../../src/workers/health-checker.js', () => ({
  HealthChecker: vi.fn(function MockHealthChecker() {
    this.verificar = vi.fn().mockResolvedValue({ podeRecuperar: true, motivos: [] });
    this.aguardarEstabilidade = vi.fn().mockResolvedValue(true);
  }),
}));

import { TabWorker, ESTADOS } from '../../../src/workers/tab-worker.js';

const mockMetrics = {
  registrarCargaConcluida: vi.fn(),
  registrarReinicializacao: vi.fn(),
};

const mockContext = {
  newPage: vi.fn().mockResolvedValue({
    isClosed: vi.fn().mockReturnValue(false),
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://portal.emiteai.com.br/#/ecommerce/shopee/consulta'),
    locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
  }),
};

describe('TabWorker', () => {
  let worker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new TabWorker(mockContext, 'ABA01', mockMetrics);
  });

  describe('constructor', () => {
    it('deve inicializar com estado idle', () => {
      expect(worker.state).toBe(ESTADOS.IDLE);
    });

    it('deve inicializar com contadores zerados', () => {
      expect(worker._contagemFalhas).toBe(0);
      expect(worker._contagemReinicializacoes).toBe(0);
    });
  });

  describe('isIdle', () => {
    it('deve retornar true quando idle', () => {
      expect(worker.isIdle).toBe(true);
    });

    it('deve retornar true quando disabled', () => {
      worker._setEstado(ESTADOS.DISABLED);
      expect(worker.isIdle).toBe(true);
    });
  });

  describe('isProcessing', () => {
    it('deve retornar false quando idle', () => {
      expect(worker.isProcessing).toBe(false);
    });

    it('deve retornar true quando processing', () => {
      worker._setEstado(ESTADOS.PROCESSING);
      expect(worker.isProcessing).toBe(true);
    });

    it('deve retornar true quando searching', () => {
      worker._setEstado(ESTADOS.SEARCHING);
      expect(worker.isProcessing).toBe(true);
    });
  });

  describe('desativar', () => {
    it('deve desativar worker idle', () => {
      const resultado = worker.desativar();
      expect(resultado).toBe(true);
      expect(worker.state).toBe(ESTADOS.DISABLED);
    });

    it('não deve desativar worker processing', () => {
      worker._setEstado(ESTADOS.PROCESSING);
      const resultado = worker.desativar();
      expect(resultado).toBe(false);
      expect(worker.state).toBe(ESTADOS.PROCESSING);
    });
  });

  describe('reativar', () => {
    it('deve reativar worker disabled', () => {
      worker._setEstado(ESTADOS.DISABLED);
      const resultado = worker.reativar();
      expect(resultado).toBe(true);
      expect(worker.state).toBe(ESTADOS.IDLE);
    });

    it('não deve reativar worker em outro estado', () => {
      const resultado = worker.reativar();
      expect(resultado).toBe(false);
    });
  });

  describe('parar', () => {
    it('deve marcar para parar', () => {
      worker.parar();
      expect(worker._deveParar).toBe(true);
    });
  });

  describe('destruir', () => {
    it('deve marcar para parar e parar timers', async () => {
      worker._iniciarHeartbeat();
      worker._iniciarWatchdog();
      await worker.destruir();
      expect(worker._deveParar).toBe(true);
      expect(worker._heartbeatInterval).toBeNull();
      expect(worker._watchdogTimer).toBeNull();
    });
  });

  describe('inicializar', () => {
    it('deve criar page e orchestrator', async () => {
      await worker.inicializar();
      expect(mockContext.newPage).toHaveBeenCalled();
      expect(worker._page).toBeDefined();
      expect(worker._orchestrator).toBeDefined();
    });
  });

  describe('executarCarga', () => {
    it('deve processar carga com sucesso', async () => {
      await worker.inicializar();
      const carga = { nomeArquivo: 'TESTE', motorista: 'TESTE', valor: 100, rowNumber: 1 };
      const resultado = await worker.executarCarga(carga);
      expect(resultado.sucesso).toBe(true);
      expect(mockMetrics.registrarCargaConcluida).toHaveBeenCalled();
    });
  });
});
