import { logInfo, logAviso, logErro } from '../logger.js';
import { URL } from '../config.js';
import { aguardarResolucaoCloudflare, aguardarTabela } from '../browser/cloudflare.js';
import { ConsultaPage } from '../pages/consulta.page.js';
import { HealthChecker } from './health-checker.js';

export class RecoveryManager {
  constructor(page, workerId) {
    this._page = page;
    this._workerId = workerId;
    this._healthChecker = new HealthChecker(page, workerId);
    this._consulta = new ConsultaPage(page);
  }

  async tentarRecuperaçãoLocal(ultimaAcao) {
    logInfo('Tentando recuperação local', {
      worker: this._workerId,
    });

    try {
      if (ultimaAcao?.tipo === 'clique') {
        const elemento = this._page.locator(ultimaAcao.seletor).first();
        if (await elemento.count() > 0 && await elemento.isVisible()) {
          await elemento.click({ force: true });
          await new Promise(r => setTimeout(r, 1000));
          logInfo('Recuperação local: clique repetido', {
            worker: this._workerId,
          });
          return true;
        }
      }

      if (ultimaAcao?.tipo === 'preenchimento') {
        const elemento = this._page.locator(ultimaAcao.seletor).first();
        if (await elemento.count() > 0) {
          await elemento.fill('');
          await elemento.type(ultimaAcao.valor, { delay: 30 });
          await new Promise(r => setTimeout(r, 500));
          logInfo('Recuperação local: campo re-preenchido', {
            worker: this._workerId,
          });
          return true;
        }
      }

      await this._page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 1000));

      const dialogo = this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root');
      const temDialogo = await dialogo.count() > 0;
      if (temDialogo) {
        await this._page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));
      }

      logInfo('Recuperação local: escape pressionado', {
        worker: this._workerId,
      });
      return true;
    } catch (err) {
      logAviso('Recuperação local falhou', {
        worker: this._workerId,
        erro: err.message,
      });
      return false;
    }
  }

  async recarregarAba() {
    logInfo('Recarregando aba', {
      worker: this._workerId,
    });

    try {
      await this._page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch (err) {
      logAviso('Falha no goto, tentando reload', {
        worker: this._workerId,
        erro: err.message,
      });
      try {
        await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (err2) {
        logErro('Falha no reload', {
          worker: this._workerId,
          erro: err2.message,
        });
        return false;
      }
    }

    await new Promise(r => setTimeout(r, 2000));

    const cfDetectado = await aguardarResolucaoCloudflare(this._page, 30);
    if (cfDetectado) {
      logAviso('Cloudflare resolvido após recarga', {
        worker: this._workerId,
      });
    }

    await aguardarTabela(this._page, 30000);

    try {
      await this._consulta.abrirFiltro();
      await this._consulta.definirDatas();
      logInfo('Filtro e datas redefinidos após recarga', {
        worker: this._workerId,
      });
    } catch (err) {
      logAviso('Falha ao reabrir filtro após recarga', {
        worker: this._workerId,
        erro: err.message,
      });
    }

    logInfo('Aba recarregada com sucesso', {
      worker: this._workerId,
    });
    return true;
  }

  async validarSessaoAtiva() {
    try {
      const url = this._page.url();
      if (url.includes('login') || url.includes('auth') || url.includes('cloudflare')) {
        logAviso('Sessão inativa, necessário re-login', {
          worker: this._workerId,
        });
        return false;
      }

      const tabela = this._page.locator('table, div[role="grid"], div.MuiDataGrid-root').first();
      if (await tabela.count() === 0) {
        logAviso('Tabela não encontrada, sessão pode estar inválida', {
          worker: this._workerId,
        });
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  async recuperar(erro, ultimaAcao) {
    const resultado = {
      sucesso: false,
      tipoErro: erro?.tipo || 'desconhecido',
      mensagem: erro?.message || String(erro),
    };

    logInfo('Iniciando recuperação da aba', {
      worker: this._workerId,
      tipoErro: resultado.tipoErro,
    });

    if (this._page.isClosed()) {
      logAviso('Página fechada, impossível recuperar localmente', {
        worker: this._workerId,
      });
      return resultado;
    }

    const localOk = await this.tentarRecuperaçãoLocal(ultimaAcao);
    if (localOk) {
      await new Promise(r => setTimeout(r, 2000));
      const estavel = await this._healthChecker.aguardarEstabilidade(5000);
      if (estavel) {
        resultado.sucesso = true;
        logInfo('Recuperação local bem-sucedida', {
          worker: this._workerId,
        });
        return resultado;
      }
    }

    logInfo('Recuperação local insuficiente, recarregando aba', {
      worker: this._workerId,
    });

    const recarregou = await this.recarregarAba();
    if (!recarregou) {
      logErro('Falha ao recarregar aba', {
        worker: this._workerId,
      });
      return resultado;
    }

    const sessaoOk = await this.validarSessaoAtiva();
    if (!sessaoOk) {
      logAviso('Sessão inválida após recarga', {
        worker: this._workerId,
      });
      resultado.sucesso = false;
      return resultado;
    }

    resultado.sucesso = true;
    logInfo('Recuperação por recarga bem-sucedida', {
      worker: this._workerId,
    });
    return resultado;
  }
}
