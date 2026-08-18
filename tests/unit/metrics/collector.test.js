import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetricsCollector } from '../../../src/metrics/collector.js';

vi.mock('../../../src/logger.js', () => ({
  logInfo: vi.fn(),
  logAviso: vi.fn(),
  logErro: vi.fn(),
  logSucesso: vi.fn(),
}));

describe('MetricsCollector', () => {
  let collector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe('registrarWorker', () => {
    it('deve adicionar worker ao resumo', () => {
      collector.registrarWorker('ABA01');
      const resumo = collector.obterResumo();
      expect(resumo.workersAtivos).toBe(1);
    });

    it('deve adicionar múltiplos workers', () => {
      collector.registrarWorker('ABA01');
      collector.registrarWorker('ABA02');
      collector.registrarWorker('ABA03');
      const resumo = collector.obterResumo();
      expect(resumo.workersAtivos).toBe(3);
    });
  });

  describe('removerWorker', () => {
    it('deve remover worker do resumo', () => {
      collector.registrarWorker('ABA01');
      collector.registrarWorker('ABA02');
      collector.removerWorker('ABA01');
      const resumo = collector.obterResumo();
      expect(resumo.workersAtivos).toBe(1);
    });
  });

  describe('registrarCargaConcluida', () => {
    it('deve incrementar contadores de sucesso', () => {
      collector.registrarWorker('ABA01');
      collector.registrarCargaConcluida('ABA01', 60000, true);
      const resumo = collector.obterResumo();
      expect(resumo.totalProcessadas).toBe(1);
      expect(resumo.sucesso).toBe(1);
      expect(resumo.falha).toBe(0);
    });

    it('deve incrementar contadores de falha', () => {
      collector.registrarWorker('ABA01');
      collector.registrarCargaConcluida('ABA01', 60000, false);
      const resumo = collector.obterResumo();
      expect(resumo.totalProcessadas).toBe(1);
      expect(resumo.sucesso).toBe(0);
      expect(resumo.falha).toBe(1);
    });

    it('deve acumular múltiplas cargas', () => {
      collector.registrarWorker('ABA01');
      collector.registrarWorker('ABA02');
      collector.registrarCargaConcluida('ABA01', 60000, true);
      collector.registrarCargaConcluida('ABA02', 90000, true);
      collector.registrarCargaConcluida('ABA01', 45000, false);
      const resumo = collector.obterResumo();
      expect(resumo.totalProcessadas).toBe(3);
      expect(resumo.sucesso).toBe(2);
      expect(resumo.falha).toBe(1);
    });
  });

  describe('obterTempoMedioGlobal', () => {
    it('deve retornar 0 sem cargas', () => {
      expect(collector.obterTempoMedioGlobal()).toBe(0);
    });

    it('deve calcular média correta', () => {
      collector.registrarWorker('ABA01');
      collector.registrarCargaConcluida('ABA01', 10000, true);
      collector.registrarCargaConcluida('ABA01', 20000, true);
      collector.registrarCargaConcluida('ABA01', 30000, true);
      expect(collector.obterTempoMedioGlobal()).toBe(20000);
    });
  });

  describe('obterTempoMedioRecente', () => {
    it('deve retornar 0 sem cargas', () => {
      expect(collector.obterTempoMedioRecente()).toBe(0);
    });

    it('deve calcular média das últimas N cargas', () => {
      collector.registrarWorker('ABA01');
      collector.registrarCargaConcluida('ABA01', 10000, true);
      collector.registrarCargaConcluida('ABA01', 20000, true);
      collector.registrarCargaConcluida('ABA01', 30000, true);
      collector.registrarCargaConcluida('ABA01', 40000, true);
      collector.registrarCargaConcluida('ABA01', 50000, true);
      const recente = collector.obterTempoMedioRecente(3);
      expect(recente).toBe(40000);
    });
  });

  describe('obterThroughput', () => {
    it('deve retornar 0 no início', () => {
      expect(collector.obterThroughput()).toBe(0);
    });
  });

  describe('registrarReinicializacao', () => {
    it('deve incrementar contador de reinicializações', () => {
      collector.registrarWorker('ABA01');
      collector.registrarReinicializacao('ABA01');
      collector.registrarReinicializacao('ABA01');
      const resumo = collector.obterResumo();
      expect(resumo.detalhesWorkers[0].reinicializacoes).toBe(2);
    });
  });

  describe('obterResumo', () => {
    it('deve retornar formato correto', () => {
      collector.registrarWorker('ABA01');
      collector.registrarCargaConcluida('ABA01', 60000, true);
      const resumo = collector.obterResumo();
      expect(resumo).toHaveProperty('workersAtivos');
      expect(resumo).toHaveProperty('totalProcessadas');
      expect(resumo).toHaveProperty('sucesso');
      expect(resumo).toHaveProperty('falha');
      expect(resumo).toHaveProperty('tempoMedioGlobal');
      expect(resumo).toHaveProperty('tempoMedioRecente');
      expect(resumo).toHaveProperty('throughput');
      expect(resumo).toHaveProperty('detalhesWorkers');
    });
  });
});
