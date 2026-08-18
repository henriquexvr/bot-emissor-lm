import { logInfo, logAviso } from '../logger.js';

export class HealthChecker {
  constructor(page, workerId) {
    this._page = page;
    this._workerId = workerId;
  }

  async verificar() {
    const motivos = [];

    const carregando = await this._verificarCarregamento();
    if (carregando) motivos.push('página carregando');

    const animacoes = await this._verificarAnimacoes();
    if (animacoes) motivos.push('animações em andamento');

    const spinners = await this._verificarSpinners();
    if (spinners) motivos.push('spinners ativos');

    const overlays = await this._verificarOverlays();
    if (overlays) motivos.push('overlays bloqueantes');

    const dialogos = await this._verificarDialogosConfirmacao();
    if (dialogos) motivos.push('diálogo de confirmação aberto');

    const modais = await this._verificarModais();
    if (modais) motivos.push('modal aberto');

    const podeRecuperar = motivos.length === 0;

    if (motivos.length > 0) {
      logAviso(`Health check: aguardando estabilidade`, {
        carga: this._workerId,
        motivos: motivos.join(', '),
      });
    }

    return { podeRecuperar, motivos };
  }

  async aguardarEstabilidade(timeoutMs = 10000) {
    const inicio = Date.now();
    let ultimoLog = 0;
    while (Date.now() - inicio < timeoutMs) {
      const { podeRecuperar } = await this.verificar();
      if (podeRecuperar) return true;
      const agora = Date.now();
      if (agora - ultimoLog > 5000) {
        ultimoLog = agora;
      }
      await new Promise(r => setTimeout(r, 800));
    }
    return false;
  }

  async _verificarCarregamento() {
    try {
      const readyState = await this._page.evaluate(() => document.readyState);
      return readyState !== 'complete' && readyState !== 'interactive';
    } catch {
      return false;
    }
  }

  async _verificarAnimacoes() {
    try {
      const animacoes = await this._page.evaluate(() => {
        const seletor = '.MuiDialog-root, .MuiModal-root, [role="dialog"], .MuiBackdrop-root, .MuiDrawer-root';
        const elementos = document.querySelectorAll(seletor);
        for (const el of elementos) {
          const estilo = getComputedStyle(el);
          if (estilo.transition && estilo.transition !== 'none' &&
              estilo.transitionDuration !== '0s') {
            return true;
          }
        }
        return false;
      });
      return animacoes;
    } catch {
      return false;
    }
  }

  async _verificarSpinners() {
    try {
      const seletores = [
        '.MuiCircularProgress-root',
        '.MuiLinearProgress-root',
        '[role="progressbar"]',
        '.spinner',
        '.loading',
      ];
      for (const sel of seletores) {
        const el = this._page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible()) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async _verificarOverlays() {
    try {
      const overlays = await this._page.evaluate(() => {
        const els = document.querySelectorAll('[class*="overlay"], [class*="Backdrop"]');
        for (const el of els) {
          const estilo = getComputedStyle(el);
          if (estilo.display !== 'none' && estilo.visibility !== 'hidden' &&
              parseFloat(estilo.opacity) > 0.3) {
            return true;
          }
        }
        return false;
      });
      return overlays;
    } catch {
      return false;
    }
  }

  async _verificarDialogosConfirmacao() {
    try {
      const dialogo = this._page.locator('div[role="dialog"]:has-text("Você confirma"), div[role="presentation"].MuiDialog-root:has-text("Você confirma")').first();
      return await dialogo.count() > 0 && await dialogo.isVisible();
    } catch {
      return false;
    }
  }

  async _verificarModais() {
    try {
      const dialogo = this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root').first();
      if (await dialogo.count() > 0 && await dialogo.isVisible()) {
        const temConteudo = await this._page.evaluate(() => {
          const d = document.querySelector('div[role="dialog"], div[role="presentation"].MuiDialog-root');
          return d && d.innerText && d.innerText.trim().length > 0;
        });
        return temConteudo;
      }
      return false;
    } catch {
      return false;
    }
  }
}
