import { logInfo, logAviso } from '../logger.js';
import { CargaContext } from '../context/carga-context.js';
import { MAX_REPROCESS_PER_CARGA } from '../config.js';

const COOLDOWN_FILA2_MS = 5000;
const MAX_TENTATIVAS_FILA1 = 5;
const MAX_TENTATIVAS_FILA2 = 25;

export class SharedQueueManager {
  constructor() {
    this._fila1 = [];
    this._fila2 = [];
    this._fila3 = [];
    this._processadas = new Set();
    this._cargasCompletas = new Map();
    this._lock = Promise.resolve();
  }

  get fila1Tamanho() { return this._fila1.length; }
  get fila2Tamanho() { return this._fila2.length; }
  get fila3Tamanho() { return this._fila3.length; }
  get totalProcessadas() { return this._processadas.size; }

  async _comLock(fn) {
    await this._lock;
    let resolveLock;
    this._lock = new Promise(resolve => { resolveLock = resolve; });
    try {
      return await fn();
    } finally {
      resolveLock();
    }
  }

  adicionarFila1(cargas) {
    return this._comLock(async () => {
      let adicionadas = 0;
      for (const dados of cargas) {
        if (this._processadas.has(dados.nomeArquivo)) continue;

        const contexto = dados instanceof CargaContext
          ? dados
          : new CargaContext(dados);

        contexto.definirFila('fila1');
        contexto.definirWorker(null);
        this._processadas.add(contexto.nomeArquivo);
        this._cargasCompletas.set(contexto.nomeArquivo, contexto);
        this._fila1.push(contexto);
        adicionadas++;
      }
      if (adicionadas > 0) {
        logInfo(`Fila 1: ${adicionadas} carga(s) adicionada(s)`, {
          fila1: this._fila1.length,
          fila2: this._fila2.length,
          fila3: this._fila3.length,
        });
      }
      return adicionadas;
    });
  }

  pegarProximaFila1() {
    return this._comLock(() => {
      if (this._fila1.length === 0) return null;
      const carga = this._fila1.shift();
      carga.tentativas.fila1++;
      carga.definirFila('fila1');
      return carga;
    });
  }

  pegarBlocoFila1(tamanho) {
    return this._comLock(() => {
      const bloco = this._fila1.splice(0, tamanho);
      for (const carga of bloco) {
        carga.tentativas.fila1++;
        carga.definirFila('fila1');
      }
      return bloco;
    });
  }

  devolverParaFila1(carga) {
    return this._comLock(() => {
      const tentativas = carga.tentativas.fila1 || 0;
      if (tentativas >= MAX_TENTATIVAS_FILA1) {
        logAviso(`Carga ${carga.nomeArquivo}: removida da Fila 1 apos ${MAX_TENTATIVAS_FILA1} tentativas sem sucesso`);
        carga.addAlerta('limite_fila1', `Excedeu ${MAX_TENTATIVAS_FILA1} tentativas na Fila 1`);
        this._processadas.delete(carga.nomeArquivo);
        return;
      }
      carga.definirFila('fila1');
      this._fila1.push(carga);
      logInfo(`Carga devolvida para Fila 1: ${carga.nomeArquivo} (tentativa ${carga.tentativas.fila1}/${MAX_TENTATIVAS_FILA1})`, {
        fila1: this._fila1.length,
      });
    });
  }

  moverParaFila2(carga) {
    return this._comLock(() => {
      carga.definirFila('fila2');
      this._fila2.push(carga);
      logInfo(`Carga movida para Fila 2: ${carga.nomeArquivo}`, {
        fila2: this._fila2.length,
        fila1: this._fila1.length,
        fila3: this._fila3.length,
      });
    });
  }

  pegarProximaFila2() {
    return this._comLock(() => {
      const agora = Date.now();
      for (let i = 0; i < this._fila2.length; i++) {
        const carga = this._fila2[i];
        const tentativas = carga.tentativas.fila2 || 0;
        const cooldown = tentativas === 0 ? 0 : COOLDOWN_FILA2_MS * Math.pow(2, Math.min(tentativas, 5));
        if (agora - (carga.timestamps.entradaFila2 || 0) >= cooldown) {
          this._fila2.splice(i, 1);
          carga.tentativas.fila2++;
          carga.definirFila('fila2');
          return carga;
        }
      }
      return null;
    });
  }

  devolverParaFila2(carga) {
    return this._comLock(() => {
      const tentativas = carga.tentativas.fila2 || 0;
      if (tentativas >= MAX_TENTATIVAS_FILA2) {
        logAviso(`Carga ${carga.nomeArquivo}: removida da Fila 2 apos ${MAX_TENTATIVAS_FILA2} tentativas sem sucesso`);
        carga.addAlerta('limite_fila2', `Excedeu ${MAX_TENTATIVAS_FILA2} tentativas na Fila 2`);
        this._processadas.delete(carga.nomeArquivo);
        return;
      }
      carga.definirFila('fila2');
      this._fila2.push(carga);
      logInfo(`Carga devolvida para Fila 2: ${carga.nomeArquivo} (tentativa ${carga.tentativas.fila2}/${MAX_TENTATIVAS_FILA2})`, {
        fila2: this._fila2.length,
      });
    });
  }

  moverParaFila3(carga) {
    return this._comLock(() => {
      carga.definirFila('fila3');
      this._fila3.push(carga);
      logInfo(`Carga movida para Fila 3: ${carga.nomeArquivo}`, {
        fila3: this._fila3.length,
        fila1: this._fila1.length,
        fila2: this._fila2.length,
      });
    });
  }

  pegarProximaFila3() {
    return this._comLock(() => {
      if (this._fila3.length === 0) return null;
      const carga = this._fila3.shift();
      carga.tentativas.fila3++;
      carga.definirFila('fila3');
      return carga;
    });
  }

  devolverParaFila3(carga) {
    return this._comLock(() => {
      const tentativas = carga.tentativas.fila3 || 0;
      if (tentativas >= MAX_REPROCESS_PER_CARGA) {
        logAviso(`Carga ${carga.nomeArquivo}: removida da Fila 3 apos ${MAX_REPROCESS_PER_CARGA} tentativas sem sucesso`);
        carga.addAlerta('limite_fila3', `Excedeu ${MAX_REPROCESS_PER_CARGA} tentativas na Fila 3`);
        this._processadas.delete(carga.nomeArquivo);
        return;
      }
      carga.definirFila('fila3');
      this._fila3.push(carga);
      logInfo(`Carga devolvida para Fila 3: ${carga.nomeArquivo} (tentativa ${carga.tentativas.fila3}/${MAX_REPROCESS_PER_CARGA})`);
    });
  }

  estaVazia() {
    return this._fila1.length === 0 && this._fila2.length === 0 && this._fila3.length === 0;
  }

  temCargasPendentes() {
    return this._fila1.length > 0 || this._fila2.length > 0 || this._fila3.length > 0;
  }

  obterEstatisticas() {
    return {
      fila1: this._fila1.length,
      fila2: this._fila2.length,
      fila3: this._fila3.length,
      processadas: this._processadas.size,
    };
  }

  obterTodasCargas() {
    return [...this._cargasCompletas.values()];
  }

  limpar() {
    this._fila1 = [];
    this._fila2 = [];
    this._fila3 = [];
    this._processadas.clear();
  }
}
