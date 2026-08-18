import winston from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { ROOT } from './config.js';

const logDir = resolve(ROOT, 'logs');
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const CORES = ['\x1b[32m', '\x1b[33m', '\x1b[36m', '\x1b[35m', '\x1b[34m', '\x1b[31m'];
const RESET = '\x1b[0m';
const _corCache = new Map();

function _corParaCarga(carga) {
  if (!_corCache.has(carga)) {
    const idx = _corCache.size % CORES.length;
    _corCache.set(carga, CORES[idx]);
  }
  return _corCache.get(carga);
}

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, carga, worker, fila, estado, etapa, ...meta }) => {
    let msg = `${timestamp} ${level}: ${message}`;
    if (worker) msg += ` [${worker}]`;
    if (carga) msg += ` ${_corParaCarga(carga)}[${carga}]${RESET}`;
    if (fila) msg += ` {${fila}}`;
    if (etapa) msg += ` <${etapa}>`;
    const rest = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    if (rest) msg += ` ${rest}`;
    return msg;
  })
);

const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    new winston.transports.File({
      filename: resolve(logDir, `emiteai-${new Date().toISOString().slice(0, 10)}.log`),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

export function logInfo(message, details = {}) {
  logger.info(message, details);
}

export function logAviso(message, details = {}) {
  logger.warn(message, details);
}

export function logErro(message, details = {}) {
  logger.error(message, details);
}

export function logSucesso(message, details = {}) {
  logger.info(`OK ${message}`, details);
}

export function logDecision(message, details = {}) {
  logger.info(`DECISAO ${message}`, { tipo: 'decisao', ...details });
}

export function logMetrica(message, details = {}) {
  logger.info(`METRICA ${message}`, { tipo: 'metrica', ...details });
}

export function logEstado(message, details = {}) {
  logger.info(`ESTADO ${message}`, { tipo: 'estado', ...details });
}

export default logger;
