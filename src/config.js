import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

dotenv.config({ path: resolve(root, '.env') });

function envStr(key, fallback = '') {
  return process.env[key] || fallback;
}

function envPath(key, fallback) {
  const raw = process.env[key] || fallback;
  if (!raw) return '';
  if (raw.includes(':') || raw.startsWith('/')) return resolve(raw);
  return resolve(root, raw);
}

export const GOOGLE_SHEETS_ID = envStr('GOOGLE_SHEETS_ID');
export const GOOGLE_SHEETS_GID = envStr('GOOGLE_SHEETS_GID');

export const TRANSPORTADORA = envStr(
  'TRANSPORTADORA',
  '00.000.000/0000-00 - NOME DA TRANSPORTADORA'
);

export const STATUS_ORIGEM = envStr('STATUS_ORIGEM', 'EM_PROCESSAMENTO');
export const STATUS_FINAL = envStr('STATUS_FINAL', 'CARGA_FINALIZADA');
export const STATUS_VEICULO_SEM_PLACA = envStr('STATUS_VEICULO_SEM_PLACA', 'VEICULO_SEM_PLACA');
export const STATUS_MOTORISTA_NAO_CADASTRADO = envStr('STATUS_MOTORISTA_NAO_CADASTRADO', 'MOTORISTA_NAO_CADASTRADO');
export const STATUS_PLACA_REJEITADA = envStr('STATUS_PLACA_REJEITADA', 'PLACA_REJEITADA');
export const STATUS_PLACA_NAO_CADASTRADA = envStr('STATUS_PLACA_NAO_CADASTRADA', 'PLACA_NAO_CADASTRADA');
export const STATUS_DADOS_INCOMPLETOS = envStr('STATUS_DADOS_INCOMPLETOS', 'DADOS_INCOMPLETOS');

export const EMITIR_AVERBACAO = envStr('EMITIR_AVERBACAO', 'true') === 'true';

export const MODO_EXECUCAO = envStr('MODO_EXECUCAO', 'desenvolvimento');
export const IS_HEADLESS = MODO_EXECUCAO === 'headless';

export const CHROME_USER_DATA = envPath('CHROME_USER_DATA', 'chrome_bot_profile');
export const CHROME_DEBUG_PORT = 9222;

const hoje = new Date();
const dataFinal = hoje.toISOString().slice(0, 10);
const dataInicio = new Date(hoje);
dataInicio.setDate(dataInicio.getDate() - 30);
const dataInicial = dataInicio.toISOString().slice(0, 10);
export const URL = `https://portal.emiteai.com.br/#/ecommerce/shopee/consulta?dataInicial=${dataInicial}&dataFinal=${dataFinal}`;
export const BASE_DOMAIN = 'portal.emiteai.com.br';

export const SHEETS_CREDENTIALS_FILE = resolve(root, 'credentials.json');
export const SHEETS_TOKEN_FILE = resolve(root, 'token.json');

if (!existsSync(SHEETS_CREDENTIALS_FILE)) {
  console.error(`credentials.json não encontrado em ${SHEETS_CREDENTIALS_FILE}`);
  process.exit(1);
}

export const MAX_CONSECUTIVE_FAILURES = 5;
export const MAX_RETRIES_POR_CARGA = 3;
export const POLLING_TIMEOUT_SEGUNDOS = 180;
export const POLLING_INTERVALO_INICIAL = 0.8;
export const MAX_CONCURRENT_PAGES = parseInt(envStr('MAX_CONCURRENT_PAGES', '4'), 10);

export const MAX_RECOVERY_PER_TAB = parseInt(envStr('MAX_RECOVERY_PER_TAB', '3'), 10);
export const MAX_REPROCESS_PER_CARGA = parseInt(envStr('MAX_REPROCESS_PER_CARGA', '2'), 10);
export const IDLENESS_TIMEOUT_MS = parseInt(envStr('IDLENESS_TIMEOUT_MS', '180000'), 10);
export const MAX_CARGA_TIMEOUT_MS = parseInt(envStr('MAX_CARGA_TIMEOUT_MS', '300000'), 10);
export const PACE_DEGRADATION_THRESHOLD_MS = parseInt(envStr('PACE_DEGRADATION_THRESHOLD_MS', '90000'), 10);
export const PACE_STABILIZATION_WAIT_MS = parseInt(envStr('PACE_STABILIZATION_WAIT_MS', '120000'), 10);
export const MIN_CONCURRENT_PAGES = parseInt(envStr('MIN_CONCURRENT_PAGES', '1'), 10);
export const MAX_CARGAS_LOTES = parseInt(envStr('MAX_CARGAS_LOTES', '0'), 10);

export const BATCH_SIZE = parseInt(envStr('BATCH_SIZE', '20'), 10);
export const PASSADA_1_BLOCO_TAMANHO = parseInt(envStr('PASSADA_1_BLOCO_TAMANHO', '10'), 10);
export const FLUXO_1_BATCH_LIMIT = BATCH_SIZE;
export const PASSADA_2_MAX_TENTATIVAS_PLAY = parseInt(envStr('PASSADA_2_MAX_TENTATIVAS_PLAY', '2'), 10);
export const PASSADA_2_MAX_TENTATIVAS_FILA = parseInt(envStr('PASSADA_2_MAX_TENTATIVAS_FILA', '10'), 10);
export const LOOP_INTERVALO_MS = parseInt(envStr('LOOP_INTERVALO_MS', '10000'), 10);
export const NUM_WORKERS = parseInt(envStr('NUM_WORKERS', '2'), 10);
export const NUM_WORKERS_F1 = parseInt(envStr('NUM_WORKERS_F1', '1'), 10);
export const NUM_WORKERS_F23 = parseInt(envStr('NUM_WORKERS_F23', '4'), 10);

export const ROOT = root;
