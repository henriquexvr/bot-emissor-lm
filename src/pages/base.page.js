import { URL, BASE_DOMAIN } from '../config.js';

export class BasePage {
  constructor(page) {
    this._page = page;
    this._cargaNome = null;
  }

  definirCarga(nome) {
    this._cargaNome = nome;
  }

  async navegar(url = URL) {
    await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  }

  async aguardarLoadState(state = 'networkidle', timeout = 30000) {
    await this._page.waitForLoadState(state, { timeout });
  }

  async fecharDialogosComEscape(repeat = 1) {
    for (let i = 0; i < repeat; i++) {
      try {
        const dialogo = this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root');
        if (await dialogo.count() > 0) {
          await this._page.keyboard.press('Escape');
          await this._page.waitForTimeout(200);
        }
        await this._page.evaluate(() => {
          document.querySelectorAll('div.MuiDialog-container, div[role="dialog"], div.MuiBackdrop-root, .MuiModal-root, div[role="presentation"].MuiDialog-root').forEach(el => el.remove());
        });
        await this._page.waitForTimeout(200);
      } catch {
      }
    }
  }

  async navegarParaConsulta() {
    await this._page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await this._page.waitForTimeout(1000);
  }
}
