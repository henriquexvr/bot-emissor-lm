import { BasePage } from './base.page.js';
import { logInfo, logAviso } from '../logger.js';

export class ConsultaPage extends BasePage {
  constructor(page) {
    super(page);
  }

  async abrirFiltro() {
    const tentar = async (timeout) => {
      await this.fecharDialogosComEscape(5);
      await this._page.evaluate(() => {
        document.querySelectorAll('.MuiBackdrop-root, div.MuiDialog-container, .MuiModal-root, [role="presentation"]').forEach(d => { if (d.parentElement) d.parentElement.removeChild(d); });
      });
      await this._page.waitForTimeout(500);

      const btn = this._page.getByRole('button', { name: 'Filtrar' });
      await btn.waitFor({ state: 'visible', timeout });
      await btn.click();
    };

    try {
      await tentar(15000);
    } catch {
      try {
        const btn = this._page.locator('button:has-text("Filtrar")').first();
        await btn.waitFor({ state: 'visible', timeout: 10000 });
        await btn.click();
      } catch {
        logAviso('Botão Filtrar não encontrado, tentando reload', { carga: this._cargaNome });
        await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await this._page.waitForTimeout(3000);
        const btn = this._page.getByRole('button', { name: 'Filtrar' });
        await btn.waitFor({ state: 'visible', timeout: 20000 });
        await btn.click();
      }
    }

    await this._page.waitForTimeout(1500);
    logInfo('Filtro aberto', { carga: this._cargaNome });
  }

  async definirData(label, diasOffset) {
    const fieldset = this._page.locator(`fieldset:has-text("${label}")`).first();
    const btnCal = fieldset.locator('button').first();
    if (await btnCal.count() === 0) return;

    await btnCal.click();
    await this._page.waitForTimeout(400);

    const data = new Date();
    if (diasOffset) {
      data.setDate(data.getDate() + diasOffset);
    }
    const dia = data.getDate();
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const ano = data.getFullYear();

    const diaBtn = this._page.getByRole('gridcell', { name: String(dia) }).first();

    if (await diaBtn.count() > 0) {
      await diaBtn.click();
      await this._page.waitForTimeout(250);
    }

    const okBtn = this._page.getByRole('button', { name: 'OK' });
    if (await okBtn.count() > 0) {
      await okBtn.click();
    }

    await this._page.waitForTimeout(300);
  }

  async definirDatas() {
    await this.definirData('Data Inicial', -30);
    await this.definirData('Data Final', 0);
  }

  async preencherNomeArquivo(nome) {
    await this.fecharDialogosComEscape();

    let input = this._page.getByPlaceholder('Nome do arquivo');
    if (await input.count() === 0) {
      input = this._page.locator('label:has-text("Nome do arquivo")').locator('..').locator('input').first();
    }
    if (await input.count() === 0) {
      logAviso('Input nome do arquivo não encontrado, reabrindo filtro', { carga: this._cargaNome });
      await this.abrirFiltro();
      input = this._page.getByPlaceholder('Nome do arquivo');
    }

    if (await input.count() > 0) {
      await input.click({ force: true });
      await input.fill(nome);
      await this._page.waitForTimeout(100);
      logInfo(`Nome do arquivo preenchido: ${nome}`, { carga: this._cargaNome });
    } else {
      logAviso('Não foi possível encontrar o campo Nome do arquivo', { carga: this._cargaNome });
    }
  }

  async clicarPesquisar() {
    await this._page.waitForTimeout(100);

    const clicado = await this._page.evaluate(() => {
      document.querySelectorAll('.MuiBackdrop-root, div.MuiDialog-container, .MuiModal-root').forEach(d => {
        if (d.parentElement) d.parentElement.removeChild(d);
      });
      const btnEl = Array.from(document.querySelectorAll('button')).find(b => {
        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
        return t === 'pesquisar';
      });
      if (btnEl) { btnEl.click(); return true; }
      return false;
    });

    if (clicado) {
      await this._page.waitForTimeout(300);
      logInfo('Pesquisa executada', { carga: this._cargaNome });
      return;
    }

    const btn = this._page.getByRole('button', { name: 'PESQUISAR' });

    try {
      await btn.click({ force: true, timeout: 8000 });
      await this._page.waitForTimeout(300);
      logInfo('Pesquisa executada (force fallback)', { carga: this._cargaNome });
      return;
    } catch {
      logAviso('PESQUISAR force fallback falhou', { carga: this._cargaNome });
    }
  }

  async _linhaPorTexto(nome, timeout = 15000) {
    const grid = this._page.locator('table, div[role="grid"], div.MuiDataGrid-root').first();
    const linha = grid.locator('tr, div[role="row"]').filter({ hasText: nome }).first();
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await linha.count() > 0) return linha;
      await this._page.waitForTimeout(300);
    }
    throw new Error(`Row not found: ${nome}`);
  }

  async localizarLinha(nome) {
    try {
      const linha = await this._linhaPorTexto(nome, 15000);
      logInfo(`Linha localizada: ${nome}`, { carga: this._cargaNome });
      return linha;
    } catch {
      logAviso(`Linha não encontrada: ${nome}`, { carga: this._cargaNome });
      return null;
    }
  }

  async localizarLinhaRapido(nome) {
    try {
      return await this._linhaPorTexto(nome, 2000);
    } catch {
      return null;
    }
  }

  async lerStatus(linha) {
    if (!linha) return '';

    const statusPatterns = [
      'Aguardando Emissão', 'Aguardando Conferência',
      'Carga Finalizada', 'sem placa', 'Sem Placa',
      'Motorista',
    ];

    try {
      const cells = linha.locator('td, div[role="cell"], div[class*="cell"]');
      const cellCount = await cells.count();
      for (let i = 0; i < cellCount; i++) {
        const text = (await cells.nth(i).innerText()).trim();
        if (text) {
          const matched = statusPatterns.find(p => text.includes(p));
          if (matched) return text;
        }
      }
    } catch {}

    try {
      const rowText = await linha.evaluate(el => el.innerText || el.textContent);
      if (rowText) {
        const lines = rowText.split('\n').map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          const matched = statusPatterns.find(p => line.includes(p));
          if (matched) return line;
        }
      }
    } catch {}

    return '';
  }

  async statusAguardando(linha) {
    const status = await this.lerStatus(linha);
    return status.includes('Aguardando Emissão');
  }

  async statusFinalizado(linha) {
    if (linha) {
      const status = await this.lerStatus(linha);
      return status.includes('Carga Finalizada');
    }
    return false;
  }

  async statusFinalizadoNaPagina(nomeArquivo) {
    if (nomeArquivo) {
      const linha = await this.localizarLinha(nomeArquivo);
      if (linha) {
        const status = await this.lerStatus(linha);
        return status.includes('Carga Finalizada');
      }
      return false;
    }
    const el = this._page.locator('div:has-text("Carga Finalizada")').first();
    return await el.count() > 0;
  }

  async clicarPlay(linha) {
    const tentarClick = async (btn) => {
      if (await btn.count() === 0) return null;
      await btn.scrollIntoViewIfNeeded();
      await this._page.waitForTimeout(200);
      await btn.click({ force: true });
      return btn;
    };

    for (const seletor of [
      'span.material-icons:text-is("start")',
      'span.material-icons:text-is("play_arrow")',
      'span.material-icons',
    ]) {
      try {
        const btn = linha.locator('button').filter({ has: this._page.locator(seletor) }).first();
        if (await btn.count() > 0) {
          const clicado = await tentarClick(btn);
          if (clicado) {
            await this._page.waitForTimeout(1000);
            logInfo('Botão play clicado (Playwright)', { carga: this._cargaNome });
            return true;
          }
        }
      } catch {}
    }

    try {
      const ultimaCelula = linha.locator('td:last-child, div[role="cell"]:last-child');
      const btn = ultimaCelula.locator('button, a, [role="button"]').first();
      if (await tentarClick(btn)) {
        await this._page.waitForTimeout(1000);
        logInfo('Botão play clicado (ultima celula)', { carga: this._cargaNome });
        return true;
      }
    } catch {}

    try {
      const btn = linha.locator('button').first();
      await btn.scrollIntoViewIfNeeded();
      await this._page.waitForTimeout(200);
      await btn.click({ force: true });
      await this._page.waitForTimeout(1000);
      logInfo('Botão play clicado (fallback)', { carga: this._cargaNome });
      return true;
    } catch {}

    if (this._cargaNome) {
      try {
        const clicado = await this._page.evaluate((nomeArquivo) => {
          const grid = document.querySelector('table, div[role="grid"], div.MuiDataGrid-root');
          if (!grid) return false;
          const rows = grid.querySelectorAll('tr, div[role="row"]');
          for (const row of rows) {
            if (!row.innerText.includes(nomeArquivo)) continue;
            const icons = row.querySelectorAll('span.material-icons');
            for (const icon of icons) {
              const text = icon.textContent.trim();
              if (text === 'start' || text === 'play_arrow') {
                const btn = icon.closest('button') || icon.parentElement?.closest('button');
                if (btn) { btn.click(); return true; }
              }
            }
            const cells = row.querySelectorAll('td, div[role="cell"]');
            const lastCell = cells[cells.length - 1];
            if (lastCell) {
              const firstBtn = lastCell.querySelector('button');
              if (firstBtn) { firstBtn.click(); return true; }
            }
            const anyBtn = row.querySelector('button');
            if (anyBtn) { anyBtn.click(); return true; }
          }
          return false;
        }, this._cargaNome);
        if (clicado) {
          await this._page.waitForTimeout(1000);
          logInfo('Botão play clicado (evaluate)', { carga: this._cargaNome });
          return true;
        }
      } catch (err) {
        logAviso(`clicarPlay evaluate falhou: ${err.message}`, { carga: this._cargaNome });
      }
    }

    logAviso('Botão play/seta não encontrado na linha', { carga: this._cargaNome });
    return false;
  }

  async clicarConferir(linha) {
    if (!linha) {
      logAviso('Linha inválida para clicar Conferir', { carga: this._cargaNome });
      return false;
    }

    try {
      const cells = linha.locator('td, div[role="cell"]');
      const cellCount = await cells.count();
      if (cellCount > 0) {
        const lastCell = cells.nth(cellCount - 1);
        const actionBtn = lastCell.locator('button').filter({
          has: this._page.locator('span.material-icons, svg, i').first()
        }).first();
        if (await actionBtn.count() > 0) {
          await actionBtn.waitFor({ state: 'visible', timeout: 5000 });
          await actionBtn.click();
          logInfo('Botão Conferir clicado (ultima celula)', { carga: this._cargaNome });
          return true;
        }
      }

      const iconBtn = linha.locator('button').filter({
        has: this._page.locator('span.material-icons:text-is("edit"), span.material-icons:text-is("visibility")').first()
      }).first();
      if (await iconBtn.count() > 0) {
        await iconBtn.waitFor({ state: 'visible', timeout: 5000 });
        await iconBtn.click();
        logInfo('Botão Conferir clicado (icone)', { carga: this._cargaNome });
        return true;
      }

      const textBtn = linha.locator('button:has-text("Conferir")').first();
      if (await textBtn.count() > 0) {
        await textBtn.waitFor({ state: 'visible', timeout: 5000 });
        await textBtn.click();
        logInfo('Botão Conferir clicado (texto)', { carga: this._cargaNome });
        return true;
      }

      logAviso('Botão Conferir não encontrado na linha', { carga: this._cargaNome });
      return false;
    } catch (err) {
      logAviso(`Botão Conferir não encontrado: ${err.message}`, { carga: this._cargaNome });
      return false;
    }
  }

  async clicarOpcoes(linha) {
    const seletores = [
      linha.locator('button[title="Mais opções"], button[title="Opções"]').first(),
      linha.locator('button:has(span.material-icons:text-is("more_vert"))').first(),
      linha.locator('span.material-icons:text-is("more_vert")').first(),
      linha.locator('td').nth(11).locator('button').last().first(),
      this._page.locator('span.material-icons:text-is("more_vert")').first(),
    ];

    for (const btn of seletores) {
      try {
        if (await btn.count() === 0) continue;
        await btn.waitFor({ state: 'visible', timeout: 5000 });
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ force: true });
        await this._page.waitForTimeout(500);
        logInfo('Menu de opções aberto', { carga: this._cargaNome });
        return true;
      } catch {
        continue;
      }
    }

    logAviso('Botão de opções não encontrado, debug: procurando todos more_vert', { carga: this._cargaNome });
    try {
      const allMoreVert = await this._page.locator('span.material-icons:text-is("more_vert")').count();
      logAviso(`Debug: ${allMoreVert} botoes more_vert encontrados na pagina`, { carga: this._cargaNome });
    } catch {}
    return false;
  }

  async clicarConferirCargaMenu() {
    const seletores = [
      () => this._page.locator('.MuiMenuItem-root').filter({ hasText: 'Conferir Carga' }).first(),
      () => this._page.locator('.MuiMenuItem-root').filter({ hasText: 'Conferir' }).first(),
      () => this._page.locator('li').filter({ hasText: 'Conferir Carga' }).first(),
      () => this._page.getByRole('menuitem', { name: 'Conferir Carga' }).first(),
      () => this._page.locator('ul[role="menu"] li').filter({ hasText: 'Conferir' }).first(),
      () => this._page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: 'Conferir' }).first(),
      () => this._page.locator('div[role="menu"] div, ul[role="menu"] li').filter({ hasText: 'Conferir' }).first(),
    ];

    await this._page.waitForTimeout(900);

    for (const buscar of seletores) {
      try {
        const item = buscar();
        if (await item.count() === 0) continue;
        await item.waitFor({ state: 'visible', timeout: 3000 });
        await item.click();
        await this._page.waitForTimeout(500);
        logInfo('Conferir Carga selecionado no menu', { carga: this._cargaNome });
        return true;
      } catch {
        continue;
      }
    }

    try {
      const menuDebug = await this._page.evaluate(() => {
        const results = {};
        const roleMenu = document.querySelector('[role="menu"]');
        results.roleMenu = roleMenu ? roleMenu.innerHTML.substring(0, 500) : 'NOT_FOUND';
        results.roleMenuText = roleMenu ? roleMenu.innerText : 'EMPTY';
        const muiList = document.querySelector('.MuiMenu-list, .MuiList-root');
        results.muiList = muiList ? muiList.innerHTML.substring(0, 500) : 'NOT_FOUND';
        const muiItems = document.querySelectorAll('.MuiMenuItem-root');
        results.muiItems = Array.from(muiItems).map(el => el.innerText).join(' | ');
        const allMenus = document.querySelectorAll('[role="menu"], [role="listbox"], .MuiMenu-paper');
        results.allMenusCount = allMenus.length;
        const portalMenus = document.querySelectorAll('.MuiPopover-root, .MuiModal-root');
        results.portalMenusCount = portalMenus.length;
        if (portalMenus.length > 0) {
          const lastPortal = portalMenus[portalMenus.length - 1];
          results.lastPortalText = lastPortal.innerText ? lastPortal.innerText.substring(0, 300) : 'NO_INNER_TEXT';
          results.lastPortalHtml = lastPortal.innerHTML ? lastPortal.innerHTML.substring(0, 500) : 'NO_HTML';
        }
        return results;
      });
      logAviso(`Debug menu: ${JSON.stringify(menuDebug)}`, { carga: this._cargaNome });
    } catch (e) {
      logAviso(`Debug menu erro: ${e.message}`, { carga: this._cargaNome });
    }

    logAviso('Item Conferir Carga não encontrado no menu', { carga: this._cargaNome });

    try {
      const fallback = await this._page.evaluate(() => {
        const all = document.querySelectorAll('*');
        const matches = [];
        for (const el of all) {
          if (el.innerText && el.innerText.includes('Conferir Carga') && el.offsetHeight > 0) {
            matches.push({
              tag: el.tagName,
              class: el.className.substring(0, 100),
              text: el.innerText.substring(0, 100),
              rect: el.getBoundingClientRect()
            });
          }
        }
        return matches.slice(0, 5);
      });
      if (fallback.length > 0) {
        logAviso(`Debug fallback: ${JSON.stringify(fallback)}`, { carga: this._cargaNome });
        for (const item of fallback) {
          try {
            await this._page.click(`text=Conferir Carga`, { timeout: 5000 });
            await this._page.waitForTimeout(500);
            logInfo('Conferir Carga clicado via text= fallback', { carga: this._cargaNome });
            return true;
          } catch { }
        }
      }
    } catch (e) {
      logAviso(`Debug fallback erro: ${e.message}`, { carga: this._cargaNome });
    }

    await this._page.keyboard.press('Escape');
    await this._page.waitForTimeout(400);
    return false;
  }

  async clicarAtualizar() {
    try {
      await this.fecharDialogosComEscape(3);
      const btn = this._page.getByRole('button', { name: 'Atualizar' }).first();
      if (await btn.count() > 0) {
        await btn.click({ force: true });
        await this._page.waitForTimeout(300);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async aguardarDialogAbrir(timeout = 20000) {
    try {
      await this._page.getByRole('dialog').waitFor({ state: 'visible', timeout });
      logInfo('Dialog aberto (getByRole)', { carga: this._cargaNome });
      return true;
    } catch {
      try {
        const dialog = this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root').first();
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
        logInfo('Dialog aberto (fallback)', { carga: this._cargaNome });
        return true;
      } catch {
        logAviso('Dialog nao abriu apos o clique, tentando limpeza + retry', { carga: this._cargaNome });
        await this.fecharDialogosComEscape(5);
        await this._page.evaluate(() => {
          document.querySelectorAll('.MuiBackdrop-root, div.MuiDialog-container, .MuiModal-root, [role="presentation"]').forEach(d => {
            if (d.parentElement) d.parentElement.removeChild(d);
          });
        });
        await this._page.waitForTimeout(1000);
        try {
          const dialog = this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root').first();
          await dialog.waitFor({ state: 'visible', timeout: 10000 });
          logInfo('Dialog aberto (limpeza)', { carga: this._cargaNome });
          return true;
        } catch {
          logAviso('Dialog nao abriu apos o clique', { carga: this._cargaNome });
          return false;
        }
      }
    }
  }

  async pesquisarArquivo(nome) {
    await this.fecharDialogosComEscape();
    await this.preencherNomeArquivo(nome);
    await this.clicarPesquisar();
    return this.localizarLinha(nome);
  }
}
