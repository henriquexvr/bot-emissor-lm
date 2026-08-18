import { existsSync, mkdirSync } from 'fs';
import { chromium } from 'playwright';
import { logInfo } from '../logger.js';
import { CHROME_USER_DATA, IS_HEADLESS } from '../config.js';

export class BrowserManager {
  constructor() {
    this._browser = null;
    this._context = null;
    this._page = null;
  }

  async start() {
    const profileDir = CHROME_USER_DATA;

    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
    }

    logInfo(`Iniciando navegador com perfil: ${profileDir}`);

    this._context = await chromium.launchPersistentContext(profileDir, {
      headless: IS_HEADLESS,
      viewport: { width: 1366, height: 768 },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const pages = this._context.pages();
    this._page = pages.length > 0 ? pages[0] : await this._context.newPage();

    logInfo('Navegador iniciado com Playwright');
  }

  async stop() {
    try {
      if (this._context) await this._context.close();
    } catch { }
    try {
      if (this._browser) await this._browser.close();
    } catch { }
  }

  async isConnected() {
    try {
      return !!this._page?.url();
    } catch {
      return false;
    }
  }

  async ensureAlive() {
    if (await this.isConnected()) return true;
    return false;
  }

  get page() {
    return this._page;
  }

  get context() {
    return this._context;
  }

  async newPage() {
    const page = await this._context.newPage();
    return page;
  }
}

export default BrowserManager;
