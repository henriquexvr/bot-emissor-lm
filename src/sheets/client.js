import { existsSync, readFileSync, writeFileSync } from 'fs';
import { logInfo, logAviso } from '../logger.js';
import {
  GOOGLE_SHEETS_ID,
  GOOGLE_SHEETS_GID,
  STATUS_ORIGEM,
  STATUS_DADOS_INCOMPLETOS,
  SHEETS_CREDENTIALS_FILE,
  SHEETS_TOKEN_FILE,
} from '../config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

function loadCredentials() {
  return JSON.parse(readFileSync(SHEETS_CREDENTIALS_FILE, 'utf-8'));
}

function loadToken() {
  if (!existsSync(SHEETS_TOKEN_FILE)) return null;
  return JSON.parse(readFileSync(SHEETS_TOKEN_FILE, 'utf-8'));
}

function saveToken(tokens) {
  const antigo = loadToken() || {};
  const merged = {
    ...tokens,
    refresh_token: tokens.refresh_token || antigo.refresh_token,
  };
  writeFileSync(SHEETS_TOKEN_FILE, JSON.stringify(merged, null, 2));
}

async function refreshAccessToken(token) {
  const { installed } = loadCredentials();
  const params = new URLSearchParams({
    client_id: installed.client_id,
    client_secret: installed.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Falha ao renovar token: ${err}`);
  }

  const data = await resp.json();
  data.expiry_date = Date.now() + data.expires_in * 1000;
  delete data.expires_in;
  saveToken(data);
  return data;
}

function normalizeToken(raw) {
  if (raw.access_token) return raw;
  return {
    access_token: raw.token || raw.access_token,
    refresh_token: raw.refresh_token,
    scope: Array.isArray(raw.scopes) ? raw.scopes.join(' ') : raw.scope,
    token_type: raw.token_type || 'Bearer',
    expiry_date: raw.expiry
      ? new Date(raw.expiry).getTime()
      : raw.expiry_date,
  };
}

async function getAccessToken() {
  let raw = loadToken();
  if (!raw) {
    throw new Error('token.json não encontrado');
  }

  let token = normalizeToken(raw);
  if (!token.access_token) {
    throw new Error('token.json inválido: sem access_token');
  }

  if (token.expiry_date && Date.now() > token.expiry_date - 60000) {
    logInfo('Token expirado, renovando...');
    token = await refreshAccessToken(token);
  }

  return token.access_token;
}

async function fetchSheets(method, path, body = null, tentativa = 1, maxTentativas = 3) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEETS_ID}${path}`;

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, options);
    if (!resp.ok) {
      const err = await resp.text();
      if (resp.status >= 500 && tentativa < maxTentativas) {
        const delay = Math.min(1000 * Math.pow(2, tentativa - 1), 10000);
        logInfo(`Sheets API erro ${resp.status}, retry em ${delay}ms (tentativa ${tentativa}/${maxTentativas})`);
        await new Promise(r => setTimeout(r, delay));
        return fetchSheets(method, path, body, tentativa + 1, maxTentativas);
      }
      throw new Error(`Sheets API error: ${resp.status} - ${err}`);
    }
    return resp.json();
  } catch (err) {
    if (tentativa < maxTentativas && err.message.includes('fetch')) {
      const delay = Math.min(1000 * Math.pow(2, tentativa - 1), 10000);
      logInfo(`Sheets API erro de rede, retry em ${delay}ms (tentativa ${tentativa}/${maxTentativas})`);
      await new Promise(r => setTimeout(r, delay));
      return fetchSheets(method, path, body, tentativa + 1, maxTentativas);
    }
    throw err;
  }
}

function parseValor(raw) {
  if (!raw) return 0;
  const limpo = raw
    .replace('R$', '')
    .replace(/\./g, '')
    .replace(',', '.')
    .trim();
  const num = parseFloat(limpo);
  return isNaN(num) ? 0 : num;
}

export class SheetsRepository {
  constructor() {
    this._ultimasCargasConhecidas = new Set();
  }

  async getTitle() {
    const data = await fetchSheets('GET', '');
    const aba = data.sheets.find(
      (s) => s.properties.sheetId === parseInt(GOOGLE_SHEETS_GID, 10)
    );
    if (!aba) {
      throw new Error(`Aba com GID ${GOOGLE_SHEETS_GID} não encontrada`);
    }
    return aba.properties.title;
  }

  async lerCargasPendentes() {
    const title = await this.getTitle();
    const data = await fetchSheets(
      'GET',
      `/values/${encodeURIComponent(title)}!A:J`
    );

    const rows = data.values || [];
    if (rows.length === 0) return [];

    const cargas = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const status = (row[9] || '').trim().toUpperCase();
      if (status !== STATUS_ORIGEM.toUpperCase()) continue;

      const nomeArquivo = (row[0] || '').trim();
      const cnpj = (row[3] || '').trim();
      const valor = parseValor(row[6]);

      if (!nomeArquivo || !cnpj || !valor || valor === 0) {
        logAviso(`Linha ${i + 1}: dados incompletos (nomeArquivo="${nomeArquivo}", cnpj="${cnpj}", valor="${row[6]}"), marcando DADOS_INCOMPLETOS`);
        await this.atualizarStatus(i + 1, STATUS_DADOS_INCOMPLETOS);
        continue;
      }

      cargas.push({
        nomeArquivo,
        motorista: (row[1] || '').trim(),
        cnpj,
        valor,
        rowNumber: i + 1,
        status: (row[9] || '').trim(),
      });
    }

    logInfo(`${cargas.length} carga(s) pendente(s) encontrada(s)`);
    return cargas;
  }

  async lerCargasNovas() {
    const cargas = await this.lerCargasPendentes();
    const novas = cargas.filter(c => !this._ultimasCargasConhecidas.has(c.nomeArquivo));

    for (const carga of cargas) {
      this._ultimasCargasConhecidas.add(carga.nomeArquivo);
    }

    if (novas.length > 0) {
      logInfo(`${novas.length} carga(s) nova(s) detectada(s)`);
    }

    return novas;
  }

  async atualizarStatus(rowNumber, status) {
    const title = await this.getTitle();
    await fetchSheets('PUT', `/values/${encodeURIComponent(title)}!J${rowNumber}?valueInputOption=RAW`, {
      values: [[status]],
    });
    logInfo(`Status atualizado para "${status}" na linha ${rowNumber}`);
  }
}
