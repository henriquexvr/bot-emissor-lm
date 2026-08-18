import { randomUUID } from 'crypto';

export class CargaContext {
  constructor(dados) {
    this.id = randomUUID();
    this.rowNumber = dados.rowNumber || null;
    this.nomeArquivo = (dados.nomeArquivo || '').trim();
    this.motorista = (dados.motorista || '').trim();
    this.expedidor = (dados.cnpj || dados.expedidor || '').trim();
    this.valor = dados.valor || 0;
    this.cnpj = (dados.cnpj || '').trim();
    this.filaAtual = null;
    this.statusPortal = '';
    this.statusPlanilha = (dados.status || '').trim();
    this.worker = null;
    this.tentativas = { fila1: 0, fila2: 0, fila3: 0 };
    this.alertas = [];
    this.timestamps = {
      criacao: Date.now(),
      entradaFila1: null,
      entradaFila2: null,
      entradaFila3: null,
      conclusao: null,
    };
    this.historico = [];
    this.veiculoSemPlaca = false;
    this.motoristaNaoCadastrado = false;
    this.placaRejeitada = false;
    this.placaNaoCadastrada = false;

    this.addHistorico('criacao', 'Contexto criado a partir dos dados da planilha');
  }

  addAlerta(tipo, mensagem) {
    this.alertas.push({
      tipo,
      mensagem,
      timestamp: Date.now(),
      worker: this.worker,
      fila: this.filaAtual,
    });
    this.addHistorico(`alerta_${tipo}`, mensagem);
  }

  addHistorico(etapa, detalhes) {
    this.historico.push({
      etapa,
      detalhes,
      timestamp: Date.now(),
      worker: this.worker,
      fila: this.filaAtual,
    });
  }

  definirWorker(workerId) {
    this.worker = workerId;
  }

  definirFila(fila) {
    const filaAnterior = this.filaAtual;
    this.filaAtual = fila;
    if (fila === 'fila1' && !this.timestamps.entradaFila1) {
      this.timestamps.entradaFila1 = Date.now();
    } else if (fila === 'fila2' && !this.timestamps.entradaFila2) {
      this.timestamps.entradaFila2 = Date.now();
    } else if (fila === 'fila3' && !this.timestamps.entradaFila3) {
      this.timestamps.entradaFila3 = Date.now();
    }
    this.addHistorico(`fila_${fila}`, filaAnterior ? `Movido de ${filaAnterior} para ${fila}` : `Entrou na ${fila}`);
  }

  concluir() {
    this.timestamps.conclusao = Date.now();
    this.addHistorico('conclusao', 'Carga finalizada');
  }

  tempoNaFila(fila) {
    const entrada = this.timestamps[`entrada${fila.charAt(0).toUpperCase() + fila.slice(1)}`];
    if (!entrada) return 0;
    const saida = this.timestamps.conclusao || Date.now();
    return saida - entrada;
  }

  tempoTotal() {
    if (!this.timestamps.conclusao) return Date.now() - this.timestamps.criacao;
    return this.timestamps.conclusao - this.timestamps.criacao;
  }

  paraPlanilha() {
    const status = this.alertas.length > 0 ? this._statusPorAlerta() : this.statusPlanilha;
    return {
      rowNumber: this.rowNumber,
      status: status || this.statusPlanilha,
    };
  }

  _statusPorAlerta() {
    const tipos = new Set(this.alertas.map(a => a.tipo));
    if (tipos.has('placa_rejeitada')) return 'PLACA_REJEITADA';
    if (tipos.has('placa_nao_cadastrada')) return 'PLACA_NAO_CADASTRADA';
    if (tipos.has('veiculo_sem_placa')) return 'VEICULO_SEM_PLACA';
    if (tipos.has('motorista_nao_cadastrado')) return 'MOTORISTA_NAO_CADASTRADO';
    if (tipos.has('dados_incompletos')) return 'DADOS_INCOMPLETOS';
    return null;
  }

  toJSON() {
    return {
      id: this.id,
      nomeArquivo: this.nomeArquivo,
      motorista: this.motorista,
      expedidor: this.expedidor,
      valor: this.valor,
      filaAtual: this.filaAtual,
      worker: this.worker,
      tentativas: this.tentativas,
      alertas: this.alertas,
      timestamps: this.timestamps,
      historico: this.historico.slice(-20),
      statusPlanilha: this.statusPlanilha,
    };
  }
}
