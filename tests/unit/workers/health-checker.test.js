import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthChecker } from '../../../src/workers/health-checker.js';

vi.mock('../../../src/logger.js', () => ({
  logInfo: vi.fn(),
  logAviso: vi.fn(),
  logErro: vi.fn(),
  logSucesso: vi.fn(),
}));

const criarMockPage = (overrides = {}) => ({
  evaluate: vi.fn().mockImplementation(async (fn) => {
    if (typeof fn === 'function') {
      return fn();
    }
    return 'complete';
  }),
  locator: vi.fn().mockReturnValue({
    count: vi.fn().mockResolvedValue(0),
    isVisible: vi.fn().mockResolvedValue(false),
  }),
  ...overrides,
});

describe('HealthChecker', () => {
  let checker;
  let mockPage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPage = criarMockPage();
    checker = new HealthChecker(mockPage, 'ABA01');
  });

  describe('verificar', () => {
    it('deve retornar podeRecuperar true quando estável', async () => {
      const resultado = await checker.verificar();
      expect(resultado.podeRecuperar).toBe(true);
      expect(resultado.motivos).toEqual([]);
    });

    it('deve detectar página carregando', async () => {
      mockPage.evaluate = vi.fn().mockImplementation(async () => 'loading');
      const resultado = await checker.verificar();
      expect(resultado.podeRecuperar).toBe(false);
      expect(resultado.motivos).toContain('página carregando');
    });

    it('deve detectar spinners', async () => {
      const spinnerLocator = {
        count: vi.fn().mockResolvedValue(1),
        isVisible: vi.fn().mockResolvedValue(true),
        first: vi.fn().mockReturnThis(),
      };
      const defaultLocator = {
        count: vi.fn().mockResolvedValue(0),
        isVisible: vi.fn().mockResolvedValue(false),
        first: vi.fn().mockReturnThis(),
      };
      mockPage.locator = vi.fn().mockImplementation((sel) => {
        if (sel.includes('CircularProgress') || sel.includes('LinearProgress') || sel.includes('progressbar')) {
          return spinnerLocator;
        }
        return defaultLocator;
      });
      const resultado = await checker.verificar();
      expect(resultado.podeRecuperar).toBe(false);
      expect(resultado.motivos.some(m => m.includes('spinner'))).toBe(true);
    });
  });

  describe('aguardarEstabilidade', () => {
    it('deve retornar true quando estável', async () => {
      const resultado = await checker.aguardarEstabilidade(500);
      expect(resultado).toBe(true);
    });

    it('deve retornar false no timeout', async () => {
      mockPage.evaluate = vi.fn().mockImplementation(async () => 'loading');
      const resultado = await checker.aguardarEstabilidade(100);
      expect(resultado).toBe(false);
    });
  });
});
