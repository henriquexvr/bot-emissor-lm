import { describe, it, expect, vi } from 'vitest';
import { retryAsync, aguardarCondicao } from '../../../src/utils/retry.js';

describe('retryAsync', () => {
  it('deve retornar sucesso na primeira tentativa', async () => {
    const fn = vi.fn().mockResolvedValue('sucesso');
    const resultado = await retryAsync(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(resultado).toBe('sucesso');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('deve retornar sucesso após falhas', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('erro1'))
      .mockRejectedValueOnce(new Error('erro2'))
      .mockResolvedValue('sucesso');
    const resultado = await retryAsync(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(resultado).toBe('sucesso');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('deve throw após esgotar tentativas', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('erro persistente'));
    await expect(retryAsync(fn, { maxAttempts: 2, baseDelay: 10 }))
      .rejects.toThrow('erro persistente');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('deve respeitar maxDelay', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('erro1'))
      .mockResolvedValue('ok');
    const inicio = Date.now();
    await retryAsync(fn, { maxAttempts: 2, baseDelay: 100, maxDelay: 50 });
    const elapsed = Date.now() - inicio;
    expect(elapsed).toBeLessThan(200);
  });
});

describe('aguardarCondicao', () => {
  it('deve retornar true se condição é verdadeira imediatamente', async () => {
    const condicao = vi.fn().mockResolvedValue(true);
    const resultado = await aguardarCondicao(condicao, { timeout: 1000, intervaloInicial: 10 });
    expect(resultado).toBe(true);
  });

  it('deve retornar true após condição ficar verdadeira', async () => {
    let chamadas = 0;
    const condicao = vi.fn().mockImplementation(async () => {
      chamadas++;
      return chamadas >= 3;
    });
    const resultado = await aguardarCondicao(condicao, { timeout: 5000, intervaloInicial: 10 });
    expect(resultado).toBe(true);
    expect(condicao).toHaveBeenCalledTimes(3);
  });

  it('deve retornar false no timeout', async () => {
    const condicao = vi.fn().mockResolvedValue(false);
    const resultado = await aguardarCondicao(condicao, { timeout: 100, intervaloInicial: 50 });
    expect(resultado).toBe(false);
  });
});
