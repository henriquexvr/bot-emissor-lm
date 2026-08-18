import { logInfo, logAviso } from '../logger.js';

export class PopupsPage {
  constructor(page) {
    this._page = page;
    this._cargaNome = null;
  }

  definirCarga(nome) {
    this._cargaNome = nome;
  }

  async clicarSimContinuarAntt(timeout = 10000) {
    try {
      const dialogo = this._page.locator('div[role="dialog"]:has(h2:has-text("Atenção")), div[role="presentation"].MuiDialog-root:has-text("Sim, continuar")').first();
      await dialogo.waitFor({ state: 'visible', timeout });
      const btn = this._page.getByRole('button', { name: 'Sim, continuar' });
      if (await btn.count() > 0) {
        await btn.click();
        await this._page.waitForTimeout(500);
        logInfo('Popup ANTT: clicou em Sim, continuar', { carga: this._cargaNome });
        return true;
      }
    } catch {
      logAviso('Popup ANTT não apareceu', { carga: this._cargaNome });
    }
    return false;
  }

  async clicarSimConfirmacao(timeout = 20000) {
    try {
      const dialogo = this._page.locator('div[role="dialog"]:has-text("Você confirma"), div[role="presentation"].MuiDialog-root:has-text("Você confirma")').first();
      await dialogo.waitFor({ state: 'visible', timeout });
      const btn = this._page.getByRole('button', { name: /^Sim$/ });
      await btn.waitFor({ state: 'visible', timeout: 10000 });
      await btn.click();
      await this._page.waitForTimeout(600);
      logInfo('Popup confirmação: clicou em Sim', { carga: this._cargaNome });
      return true;
    } catch {
      logAviso('Popup de confirmação não apareceu', { carga: this._cargaNome });
      return false;
    }
  }

  async _fecharDialogo(popup) {
    const seletores = [
      popup.locator('img').first(),
      popup.locator('button[aria-label="Close"]').first(),
      popup.locator('button.MuiIconButton-root').first(),
      popup.locator('button:has(svg)').first(),
      popup.locator('button:has(img)').first(),
    ];

    for (const btn of seletores) {
      try {
        if (await btn.count() > 0 && await btn.isVisible()) {
          await btn.click();
          await this._page.waitForTimeout(400);
          if (!(await popup.isVisible().catch(() => false))) return true;
        }
      } catch { continue; }
    }

    await this._page.keyboard.press('Escape');
    await this._page.waitForTimeout(400);
    if (!(await popup.isVisible().catch(() => false))) return true;

    const stillVisible = await popup.isVisible().catch(() => false);
    if (stillVisible) {
      await this._page.evaluate((dialogText) => {
        document.querySelectorAll('div[role="dialog"], div[role="presentation"].MuiDialog-root').forEach(d => {
          if (d.innerText && d.innerText.includes(dialogText)) d.remove();
        });
        document.querySelectorAll('.MuiBackdrop-root, .MuiModal-root').forEach(el => el.remove());
      }, await popup.innerText().catch(() => '')).catch(() => {});
      await this._page.waitForTimeout(400);
    }

    return true;
  }

  async _fecharPopupForcado(texto) {
    await this._page.evaluate((txt) => {
      document.querySelectorAll(
        'div[role="dialog"], div[role="presentation"].MuiDialog-root, div.MuiDialog-container, .MuiModal-root, .MuiBackdrop-root'
      ).forEach(el => {
        if (!txt || (el.innerText && el.innerText.includes(txt))) {
          el.remove();
        }
      });
    }, texto).catch(() => {});
    await this._page.waitForTimeout(300);
  }

  async fecharPopupSucesso() {
    try {
      const popup = this._page.locator('div[role="dialog"]:has-text("Solicitação de emissão")').first();
      if (await popup.count() === 0) {
        return true;
      }
      logInfo('Popup sucesso detectado, fechando...', { carga: this._cargaNome });
      const btnX = this._page.locator('div[role="dialog"] img, div[role="presentation"].MuiDialog-root img').first();
      if (await btnX.count() > 0) {
        await btnX.click();
        await this._page.waitForTimeout(600);
        logInfo('Popup sucesso fechado via img', { carga: this._cargaNome });
        return true;
      }
      await this._page.evaluate(() => {
        document.querySelectorAll('div[role="dialog"], div[role="presentation"].MuiDialog-root').forEach(d => d.remove());
        document.querySelectorAll('.MuiBackdrop-root, .MuiModal-root').forEach(el => el.remove());
      });
      await this._page.waitForTimeout(600);
      logInfo('Popup sucesso removido via evaluate', { carga: this._cargaNome });
      return true;
    } catch {
      return true;
    }
  }

  async verificarErroValor() {
    try {
      const possiveisTextos = [
        'O valor deve ser maior que zero',
        'valor abaixo do permitido',
        'valor deve ser maior',
        'valor inválido',
        'abaixo do valor mínimo',
        'valor mínimo parametrizado',
      ];
      for (const texto of possiveisTextos) {
        const dialogo = this._page.locator('div[role="dialog"]:has-text("' + texto + '"), div[role="presentation"].MuiDialog-root:has-text("' + texto + '")').first();
        if (await dialogo.count() > 0) {
          logAviso(`Erro de valor detectado: "${texto}"`, { carga: this._cargaNome });
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async fecharErroValor() {
    try {
      const popup = this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root').first();
      if (await popup.count() === 0) {
        return true;
      }

      const texto = await popup.innerText().catch(() => '');
      const isErro = texto.includes('valor') || texto.includes('Valor') ||
        texto.includes('deve ser maior') || texto.includes('permitido') ||
        texto.includes('inválido') || texto.includes('mínimo') ||
        texto.includes('parametrizado');

      if (!isErro) {
        logAviso('Nenhum popup de erro de valor detectado', { carga: this._cargaNome });
        return true;
      }

      logInfo('Popup de erro de valor detectado, fechando...', { carga: this._cargaNome });
      await this._fecharDialogo(popup);
      logInfo('Popup de erro fechado', { carga: this._cargaNome });
      return true;
    } catch {
      await this._page.keyboard.press('Escape').catch(() => {});
      await this._page.waitForTimeout(400);
      await this._fecharPopupForcado('');
      return true;
    }
  }

  async clicarSimMaiusculo(timeout = 10000) {
    try {
      const btn = this._page.locator('button:visible').filter({ hasText: /^SIM$/ }).first();
      if (await btn.count() > 0) {
        await btn.waitFor({ state: 'visible', timeout });
        await btn.click();
        await this._page.waitForTimeout(300);
        logInfo('Popup SIM maiúsculo clicado', { carga: this._cargaNome });
        return true;
      }
      const fallback = this._page.getByRole('button', { name: 'SIM' }).first();
      if (await fallback.count() > 0) {
        await fallback.click();
        await this._page.waitForTimeout(300);
        logInfo('Popup SIM maiúsculo clicado (fallback)', { carga: this._cargaNome });
        return true;
      }
      return false;
    } catch {
      logAviso('Popup SIM maiúsculo não encontrado', { carga: this._cargaNome });
      return false;
    }
  }

  async verificarPlacaRejeitada() {
    try {
      const textos = ['placa rejeitada', 'Placa Rejeitada', 'placa recusada', 'Placa Recusada'];
      for (const texto of textos) {
        const el = this._page.locator(`div[role="dialog"]:has-text("${texto}"), [role="alert"]:has-text("${texto}")`).first();
        if (await el.count() > 0 && await el.isVisible()) {
          logAviso(`Placa rejeitada detectada: "${texto}"`, { carga: this._cargaNome });
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async verificarNotificacaoPlaca() {
    try {
      const textos = ['não cadastrado', 'nao cadastrado', 'não cadastrada', 'nao cadastrada', 'não encontrada', 'nao encontrada', 'Placa não encontrado'];
      const seletores = textos.map(t => `div:has-text("${t}"):visible`).join(', ');
      const notif = this._page.locator(seletores).first();
      if (await notif.count() === 0) return false;

      const btnFechar = this._page.locator('button:has-text("×"), button[aria-label="Close"]').first();
      if (await btnFechar.count() > 0) {
        await btnFechar.click();
        await this._page.waitForTimeout(300);
      }
      logAviso('Notificação: veículo sem placa', { carga: this._cargaNome });
      return true;
    } catch {
      return false;
    }
  }
}
