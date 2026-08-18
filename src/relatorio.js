import { logInfo } from './logger.js';

function statusExibicao(carga) {
  if (carga.timestamps.conclusao) {
    if (carga.alertas.some(a => a.tipo === 'motorista_nao_cadastrado')) return 'MOTORISTA_NAO_CADASTRADO';
    if (carga.alertas.some(a => a.tipo === 'veiculo_sem_placa')) return 'VEICULO_SEM_PLACA';
    if (carga.alertas.some(a => a.tipo === 'placa_rejeitada')) return 'PLACA_REJEITADA';
    if (carga.alertas.some(a => a.tipo === 'placa_nao_cadastrada')) return 'PLACA_NAO_CADASTRADA';
    return 'CARGA_FINALIZADA';
  }
  if (carga.alertas.some(a => a.tipo === 'limite_fila2')) return 'DESCARTADA_F2';
  if (carga.alertas.some(a => a.tipo === 'limite_fila3')) return 'DESCARTADA_F3';
  return 'EM_PROCESSAMENTO';
}

function formatMs(ms) {
  const totalSeg = Math.round(ms / 1000);
  if (totalSeg < 60) return `${totalSeg}s`;
  const min = Math.floor(totalSeg / 60);
  const seg = totalSeg % 60;
  return seg > 0 ? `${min}m ${seg}s` : `${min}m`;
}

function formatMsShort(ms) {
  const totalSeg = Math.round(ms / 1000);
  if (totalSeg < 60) return `${totalSeg}s`;
  const min = Math.floor(totalSeg / 60);
  const seg = totalSeg % 60;
  return seg > 0 ? `${min}m ${seg}s` : `${min}m`;
}

export function imprimirRelatorio(queueManager, inicioPipeline) {
  const todasCargas = queueManager.obterTodasCargas();
  if (todasCargas.length === 0) {
    logInfo('Relatorio: nenhuma carga processada');
    return;
  }

  const fimPipeline = Date.now();
  const duracaoTotal = fimPipeline - inicioPipeline;

  const linhas = [];
  let finalizadas = 0;
  let descartadas = 0;
  let processamento = 0;
  let somaTempoTotal = 0;
  let somaTempoFinalizadas = 0;

  for (const carga of todasCargas) {
    const status = statusExibicao(carga);
    const tempo = carga.timestamps.conclusao
      ? carga.timestamps.conclusao - carga.timestamps.criacao
      : Date.now() - carga.timestamps.criacao;
    const tentF2 = carga.tentativas.fila2 || 0;

    linhas.push({ nome: carga.nomeArquivo, status, tempo, tentF2 });
    somaTempoTotal += tempo;

    if (status === 'CARGA_FINALIZADA' || status === 'MOTORISTA_NAO_CADASTRADO' || status === 'VEICULO_SEM_PLACA' || status === 'PLACA_REJEITADA' || status === 'PLACA_NAO_CADASTRADA') {
      finalizadas++;
      somaTempoFinalizadas += tempo;
    } else if (status.startsWith('DESCARTADA')) {
      descartadas++;
    } else {
      processamento++;
    }
  }

  const mediaGeral = todasCargas.length > 0 ? somaTempoTotal / todasCargas.length : 0;
  const mediaFinalizadas = finalizadas > 0 ? somaTempoFinalizadas / finalizadas : 0;
  const throughput = todasCargas.length / (duracaoTotal / 60000);

  const sep = '─'.repeat(78);
  console.log('');
  console.log(`  ${'='.repeat(74)}`);
  console.log(`  ${'RELATORIO DE EXECUCAO'.padStart(43)}`);
  console.log(`  ${sep}`);
  console.log(`  Inicio: ${new Date(inicioPipeline).toLocaleTimeString()}  |  Termino: ${new Date(fimPipeline).toLocaleTimeString()}  |  Duracao: ${formatMs(duracaoTotal)}`);
  console.log(`  ${sep}`);
  console.log(`  ${'CARGA'.padEnd(32)} ${'STATUS'.padEnd(27)} ${'TEMPO'.padEnd(8)} TENT F2`);
  console.log(`  ${''.padEnd(32, '─')} ${''.padEnd(27, '─')} ${''.padEnd(8, '─')} ${''.padEnd(7, '─')}`);
  for (const linha of linhas) {
    console.log(`  ${linha.nome.padEnd(32)} ${linha.status.padEnd(27)} ${formatMsShort(linha.tempo).padEnd(8)} ${String(linha.tentF2).padEnd(7)}`);
  }
  console.log(`  ${sep}`);
  console.log(`  Total: ${todasCargas.length}  |  Finalizadas: ${finalizadas}  |  Descartadas: ${descartadas}  |  Em processamento: ${processamento}`);
  console.log(`  Tempo total processado: ${formatMsShort(somaTempoTotal)}  |  Duracao pipeline: ${formatMsShort(duracaoTotal)}`);
  console.log(`  Media processamento: ${formatMsShort(mediaGeral)}  |  Media finalizadas: ${formatMsShort(mediaFinalizadas)}  |  Throughput: ${throughput.toFixed(2)} cargas/min`);
  console.log(`  ${'='.repeat(74)}`);
  console.log('');
}
