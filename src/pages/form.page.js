import { logInfo, logAviso } from '../logger.js';
import { TRANSPORTADORA, EMITIR_AVERBACAO } from '../config.js';

export class FormPage {
  constructor(page) {
    this._page = page;
    this._cargaNome = null;
  }

  definirCarga(nome) {
    this._cargaNome = nome;
  }

  async aguardarLoadState(state = 'networkidle', timeout = 30000) {
    await this._page.waitForLoadState(state, { timeout });
  }

  async configurarAverbacao(ativo = EMITIR_AVERBACAO) {
    try {
      const checkbox = this._page.locator('label:has-text("Emitir Averbação") input[type="checkbox"]').first();
      if (await checkbox.count() > 0) {
        const isChecked = await checkbox.isChecked();
        if (ativo && !isChecked) {
          await checkbox.check({ force: true });
          await this._page.waitForTimeout(300);
          logInfo('Averbação marcada', { carga: this._cargaNome });
        } else if (!ativo && isChecked) {
          await checkbox.uncheck({ force: true });
          await this._page.waitForTimeout(300);
          logInfo('Averbação desmarcada', { carga: this._cargaNome });
        }
      }
    } catch {
      logAviso('Checkbox de averbação não encontrado', { carga: this._cargaNome });
    }
  }

  async preencherValor(valor) {
    const texto = typeof valor === 'number'
      ? valor.toFixed(2).replace('.', ',')
      : String(valor);
    const dialog = this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root');

    try {
      const strategies = [
        dialog.locator('label:has-text("Valor")').locator('..').locator('input').first(),
        dialog.getByLabel('Valor').first(),
        dialog.getByPlaceholder('Valor').first(),
        dialog.getByRole('textbox').nth(2).first(),
        dialog.locator('div.MuiDialogContent-root input').nth(2),
        dialog.locator('input[id*="valor" i], input[name*="valor" i], input[id*="value" i], input[name*="value" i]').first(),
      ];

      for (const input of strategies) {
        try {
          if (await input.count() === 0) continue;
          await input.waitFor({ state: 'visible', timeout: 5000 });
          await input.click();
          await this._page.waitForTimeout(200);
          await input.fill('');
          await input.type(texto, { delay: 20 });
          await this._page.waitForTimeout(250);
          await this._page.keyboard.press('Tab');
          await this._page.waitForTimeout(250);
          logInfo('Campo Valor preenchido', { carga: this._cargaNome });
          return true;
        } catch {
          continue;
        }
      }

      logAviso('Campo Valor não encontrado (todas as estratégias falharam)', { carga: this._cargaNome });
      await this._debugDialogo(dialog);
      return false;
    } catch (err) {
      logAviso(`Campo Valor não encontrado: ${err.message}`, { carga: this._cargaNome });
      return false;
    }
  }

  async _debugDialogo(dialog) {
    try {
      const info = await this._page.evaluate(() => {
        const dlg = document.querySelector('div[role="dialog"], div[role="presentation"].MuiDialog-root');
        if (!dlg) return { error: 'no dialog' };
        const inputs = dlg.querySelectorAll('input');
        const labels = dlg.querySelectorAll('label');
        return {
          inputsCount: inputs.length,
          inputs: Array.from(inputs).map((inp, i) => ({
            idx: i,
            type: inp.type,
            name: inp.name,
            placeholder: inp.placeholder,
            id: inp.id,
            value: inp.value,
          })),
          labels: Array.from(labels).map(l => l.innerText.substring(0, 60)),
          text: dlg.innerText.substring(0, 500),
        };
      });
      logAviso(`Debug dialog: ${JSON.stringify(info)}`, { carga: this._cargaNome });
    } catch (e) {
      logAviso(`Debug dialog erro: ${e.message}`, { carga: this._cargaNome });
    }
  }

  async preencherInput(label, valor) {
    const input = this._page.locator(`label:has-text("${label}")`).locator('..').locator('input').first();
    if (await input.count() > 0) {
      await this._preencherInput(input, valor);
    } else {
      const byLabel = this._page.getByLabel(label).first();
      if (await byLabel.count() > 0) {
        await this._preencherInput(byLabel, valor);
      }
    }
  }

  async _preencherInput(input, valor) {
    await input.waitFor({ state: 'visible', timeout: 25000 });
    await input.click();
    await input.press('Control+a');
    await this._page.waitForTimeout(200);

    if (typeof valor === 'number') {
      const fmt = valor.toFixed(2).replace('.', ',');
      await input.fill(fmt);
    } else {
      await input.fill(String(valor));
    }

    await this._page.waitForTimeout(250);
    await input.press('Tab');
    await this._page.waitForTimeout(250);
  }

  async preencherTransportadora(texto = 'matriz') {
    const input = this._page.getByLabel('Transportadora*').first();
    if (await input.count() === 0) {
      const fallback = this._page.locator('label:has-text("Transportadora")').locator('..').locator('input').first();
      if (await fallback.count() > 0) {
        await this._autocompletePreencher(fallback, texto);
        await this._page.waitForTimeout(200);
        return;
      }
    }
    await this._autocompletePreencher(input, texto);
    await this._page.waitForTimeout(200);
  }

  async preencherAutocomplete(label, valor) {
    const input = this._page.getByLabel(label).first();
    if (await input.count() === 0) {
      const fallback = this._page.locator(`label:has-text("${label}")`).locator('..').locator('input').first();
      if (await fallback.count() > 0) {
        return this._autocompletePreencher(fallback, valor);
      }
    }
    return this._autocompletePreencher(input, valor);
  }

  async _autocompletePreencher(input, valor) {
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.click();
    await input.fill('');
    await input.type(valor, { delay: 20 });
    await this._page.waitForTimeout(400);

    let encontrado = false;

    try {
      const listbox = this._page.locator('ul.MuiAutocomplete-listbox');
      await listbox.waitFor({ state: 'visible', timeout: 5000 });
      const options = this._page.locator('li.MuiAutocomplete-option');
      await options.first().waitFor({ state: 'visible', timeout: 3000 });

      const qtd = await options.count();
      for (let i = 0; i < Math.min(qtd, 10); i++) {
        const texto = (await options.nth(i).innerText()).trim();
        const v = valor.toLowerCase();
        const t = texto.toLowerCase();
        const palavrasSignificativas = v.split(' ').filter(p => p.trim().length > 3);
        const todasAsPalavras = palavrasSignificativas.length > 0 &&
          palavrasSignificativas.every(p => t.includes(p));
        if (v === t || todasAsPalavras) {
          await options.nth(i).click();
          await this._page.keyboard.press('Enter');
          encontrado = true;
          return encontrado;
        }
        const vClean = valor.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const tClean = texto.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        if (vClean.length > 3 && tClean.includes(vClean)) {
          await options.nth(i).click();
          await this._page.keyboard.press('Enter');
          encontrado = true;
          return encontrado;
        }
      }
    } catch {
    }

    if (!encontrado) {
      logAviso('Motorista não encontrado no autocomplete, selecionando primeiro item', { carga: this._cargaNome });
      try {
        const options = this._page.locator('li.MuiAutocomplete-option');
        if (await options.count() > 0) {
          await options.first().click();
          await this._page.keyboard.press('Enter');
        } else {
          await this._page.keyboard.press('ArrowDown');
          await this._page.keyboard.press('Enter');
        }
      } catch {
        await this._page.keyboard.press('ArrowDown');
        await this._page.keyboard.press('Enter');
      }
    }

    return encontrado;
  }

  async clicarProximoWizard() {
    try {
      const btn = this._page.getByRole('button', { name: 'Próximo' }).first();
      if (await btn.count() === 0) return false;
      await btn.waitFor({ state: 'visible', timeout: 10000 });
      await btn.click();
      await this._page.waitForTimeout(400);
      return true;
    } catch {
      return false;
    }
  }

  async clicarCelulaValorWizard() {
    try {
      const celula = this._page.locator('td').filter({ hasText: '0,00' }).first();
      if (await celula.count() === 0) return false;
      await celula.waitFor({ state: 'visible', timeout: 10000 });
      await celula.click();
      await this._page.waitForTimeout(300);
      return true;
    } catch {
      return false;
    }
  }

  async preencherValorNoWizard(valor = 1) {
    try {
      const input = this._page.getByRole('textbox').filter({ hasText: /0,00|\d+,\d{2}/ }).first();
      if (await input.count() === 0) {
        const fallback = this._page.locator('input[type="text"]').filter({ has: this._page.locator('..') }).first();
        if (await fallback.count() === 0) return false;
        await fallback.click();
        await fallback.fill('');
        await fallback.type(String(valor), { delay: 20 });
        await this._page.waitForTimeout(200);
        await this._page.keyboard.press('Tab');
        await this._page.waitForTimeout(200);
        return true;
      }
      await input.waitFor({ state: 'visible', timeout: 10000 });
      await input.click();
      await input.fill('');
      await input.type(String(valor), { delay: 20 });
      await this._page.waitForTimeout(200);
      await this._page.keyboard.press('Tab');
      await this._page.waitForTimeout(200);
      return true;
    } catch {
      return false;
    }
  }

  async marcarReplicarValor() {
    try {
      const checkbox = this._page.locator('label:has-text("Replica valor") input[type="checkbox"]').first();
      if (await checkbox.count() === 0) {
        const fallback = this._page.locator('label:has-text("Replica") input[type="checkbox"]').first();
        if (await fallback.count() === 0) return false;
        if (!await fallback.isChecked()) {
          await fallback.click({ force: true });
          await this._page.waitForTimeout(200);
        }
        return true;
      }
      if (!await checkbox.isChecked()) {
        await checkbox.click({ force: true });
        await this._page.waitForTimeout(200);
      }
      return true;
    } catch {
      return false;
    }
  }

  async clicarConfirmarValor() {
    try {
      const btn = this._page.getByRole('button', { name: 'Confirmar' }).first();
      if (await btn.count() === 0) return false;
      await btn.waitFor({ state: 'visible', timeout: 10000 });
      await btn.click();
      await this._page.waitForTimeout(300);
      return true;
    } catch {
      return false;
    }
  }

  async clicarEmitir() {
    try {
      let btn = this._page.getByRole('button', { name: 'EmiteAí' }).first();
      if (await btn.count() === 0) {
        btn = this._page.getByRole('button', { name: 'EMITEAI' }).first();
      }
      if (await btn.count() === 0) {
        btn = this._page.getByRole('button', { name: 'Emitir' }).first();
      }

      await btn.waitFor({ state: 'visible', timeout: 25000 });
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await this._page.waitForTimeout(2000);
      logInfo('EmiteAí clicado', { carga: this._cargaNome });
      return true;
    } catch {
      logAviso('Botão EmiteAí não encontrado', { carga: this._cargaNome });
      return false;
    }
  }
}
