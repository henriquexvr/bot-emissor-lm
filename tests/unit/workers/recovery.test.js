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

vi.mock('../../../src/browser/cloudflare.js', () => ({
  aguardarResolucaoCloudflare: vi.fn().mockResolvedValue(true),
  aguardarTabela: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/workers/health-checker.js', () => ({
  HealthChecker: vi.fn(function MockHealthChecker() {
    this.verificar = vi.fn().mockResolvedValue({ podeRecuperar: true, motivos: [] });
    this.aguardarEstabilidade = vi.fn().mockResolvedValue(true);
  }),
}));

import { RecoveryManager } from '../../../src/workers/recovery.js';

const criarLocatorMock = (count = 0) => {
  const loc = {
    count: vi.fn().mockResolvedValue(count),
    isVisible: vi.fn().mockResolvedValue(count > 0),
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
  };
  return loc;
};

const criarMockPage = (overrides = {}) => ({
  goto: vi.fn().mockResolvedValue(undefined),
  reload: vi.fn().mockResolvedValue(undefined),
  isClosed: vi.fn().mockReturnValue(false),
  url: vi.fn().mockReturnValue('https://portal.emiteai.com.br/#/ecommerce/shopee/consulta'),
  locator: vi.fn().mockReturnValue(criarLocatorMock(0)),
  keyboard: {
    press: vi.fn().mockResolvedValue(undefined),
  },
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('RecoveryManager', () => {
  let recovery;
  let mockPage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage = criarMockPage();
    recovery = new RecoveryManager(mockPage, 'ABA01');
  });

  describe('tentarRecuperaçãoLocal', () => {
    it('deve tentar escape quando não há ação anterior', async () => {
      const resultado = await recovery.tentarRecuperaçãoLocal(null);
      expect(resultado).toBe(true);
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Escape');
    });

    it('deve tentar re-clicar quando ultimaAcao é clique', async () => {
      mockPage.locator = vi.fn().mockReturnValue(criarLocatorMock(1));
      const resultado = await recovery.tentarRecuperaçãoLocal({
        tipo: 'clique',
        seletor: 'button',
      });
      expect(resultado).toBe(true);
    });

    it('deve tentar re-preencher quando ultimaAcao é preenchimento', async () => {
      mockPage.locator = vi.fn().mockReturnValue(criarLocatorMock(1));
      const resultado = await recovery.tentarRecuperaçãoLocal({
        tipo: 'preenchimento',
        seletor: 'input',
        valor: 'teste',
      });
      expect(resultado).toBe(true);
    });
  });

  describe('validarSessaoAtiva', () => {
    it('deve retornar true com sessão válida', async () => {
      mockPage.locator = vi.fn().mockReturnValue(criarLocatorMock(1));
      const resultado = await recovery.validarSessaoAtiva();
      expect(resultado).toBe(true);
    });

    it('deve retornar false com URL de login', async () => {
      mockPage.url = vi.fn().mockReturnValue('https://portal.emiteai.com.br/login');
      const resultado = await recovery.validarSessaoAtiva();
      expect(resultado).toBe(false);
    });
  });

  describe('recuperar', () => {
    it('deve retornar sucesso com recuperação local', async () => {
      mockPage.locator = vi.fn().mockReturnValue(criarLocatorMock(1));
      const resultado = await recovery.recuperar(
        { tipo: 'timeout', message: 'timeout' },
        null
      );
      expect(resultado.sucesso).toBe(true);
    });
  });
});
