import { BrowserManager } from './browser/manager.js';
import { WorkerPool } from './workers/worker-pool.js';
import { SheetsRepository } from './sheets/client.js';
import { aguardarResolucaoCloudflare, aguardarTabela } from './browser/cloudflare.js';
import { logInfo, logErro, logSucesso } from './logger.js';
import { imprimirRelatorio } from './relatorio.js';
import { URL, LOOP_INTERVALO_MS, NUM_WORKERS_F1, NUM_WORKERS_F23 } from './config.js';

async function main() {
  console.log('========================================');
  console.log('  BOT EMITEAI - AUTOMACAO DE CARGAS');
  const totalWorkers = NUM_WORKERS_F1 + NUM_WORKERS_F23;
  console.log(`  Workers: ${totalWorkers} | Pipeline Concorrente (${NUM_WORKERS_F1} F1 + ${NUM_WORKERS_F23} F2/F3)`);
  console.log('========================================\n');

  const browser = new BrowserManager();
  let pool = null;

  const pararGraciosamente = async (sinal) => {
    console.log(`\n[${sinal}] Encerrando graciosamente...`);
    if (pool) {
      await pool.parar();
      await pool.destruir();
    }
    await browser.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => pararGraciosamente('SIGINT'));
  process.on('SIGTERM', () => pararGraciosamente('SIGTERM'));

  try {
    logInfo('Iniciando navegador...');
    await browser.start();

    const page = browser.page;

    logInfo('Navegando para o portal...');
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

    logInfo('Verificando Cloudflare...');
    const cfResolvido = await aguardarResolucaoCloudflare(page);
    if (!cfResolvido) {
      logErro('Cloudflare não resolvido. Abortando.');
      await browser.stop();
      process.exit(1);
    }

    await aguardarTabela(page);

    logInfo('Inicializando workers...');
    pool = new WorkerPool(page.context());
    await pool.inicializar();

    const sheets = new SheetsRepository();

    logInfo('Iniciando workers...\n');

    logInfo('Main: aguardando 3s para workers iniciarem...');
    await new Promise(r => setTimeout(r, 3000));

    logInfo('Main: lendo cargas da planilha');
    const cargasIniciais = await sheets.lerCargasPendentes();

    if (cargasIniciais.length === 0) {
      logSucesso('Nenhuma carga pendente encontrada. Encerrando.');
      await pool.parar();
      await pool.destruir();
      await browser.stop();
      return;
    }

    logInfo(`Main: ${cargasIniciais.length} carga(s) encontrada(s), adicionando à Fila 1`);
    pool.queueManager.adicionarFila1(cargasIniciais);

    logInfo('Main: pipeline concorrente iniciado (F1 prepara → F2 emite → F3 valida)');

    const inicioPipeline = Date.now();
    await pool.aguardarFinalizacao();
    imprimirRelatorio(pool.queueManager, inicioPipeline);
  } catch (err) {
    logErro('Erro fatal', { erro: err.message, stack: err.stack });
    console.error('\n[FATAL]', err.message);
  } finally {
    if (!process.argv.includes('--dev')) {
      await browser.stop();
    } else {
      console.log('\n[DEV] Navegador mantido aberto. Pressione Ctrl+C para encerrar.');
    }
  }
}

main();
