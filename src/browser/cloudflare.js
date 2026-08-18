import { logInfo, logAviso } from '../logger.js';

const CLOUDFLARE_SELECTORS = [
  '#cf-error-details',
  '.cf-browser-verification',
  '#challenge-form',
  'iframe[src*="cloudflare"]',
  '#turnstile-wrapper',
  'div[class*="cloudflare"]',
];

const TABLE_SELECTOR = 'table, div[role="grid"], div.MuiDataGrid-root';

export async function detectarCloudflare(page) {
  const url = page.url();
  if (url.includes('cloudflare') || url.includes('challenge')) {
    return true;
  }

  for (const sel of CLOUDFLARE_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible()) {
      return true;
    }
  }

  return false;
}

export async function aguardarResolucaoCloudflare(page, timeoutSegundos = 120) {
  if (!(await detectarCloudflare(page))) {
    return true;
  }

  logAviso('Cloudflare detectado. Aguardando resolução... (ate 120s)');

  const inicio = Date.now();
  while (Date.now() - inicio < timeoutSegundos * 1000) {
    await page.waitForTimeout(2000);
    if (!(await detectarCloudflare(page))) {
      logInfo('Cloudflare resolvido');
      return true;
    }
  }

  logAviso('Cloudflare não resolvido dentro do tempo limite');
  return false;
}

export async function aguardarTabela(page, timeout = 30000) {
  try {
    await page.waitForSelector(TABLE_SELECTOR, { timeout });
    logInfo('Grid da tabela carregado');
    return true;
  } catch {
    logAviso('Grid da tabela não apareceu');
    return false;
  }
}
