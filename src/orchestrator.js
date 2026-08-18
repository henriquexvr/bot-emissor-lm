import { logInfo, logAviso, logErro, logSucesso } from './logger.js';
import { SheetsRepository } from './sheets/client.js';
import { ConsultaPage } from './pages/consulta.page.js';
import { FormPage } from './pages/form.page.js';
import { PopupsPage } from './pages/popups.page.js';
import { WorkerPool } from './workers/worker-pool.js';
import { PaceController } from './metrics/pace-controller.js';
import { aguardarCondicao } from './utils/retry.js';
import {
  URL,
  STATUS_FINAL,
  STATUS_VEICULO_SEM_PLACA,
  STATUS_MOTORISTA_NAO_CADASTRADO,
  STATUS_PLACA_REJEITADA,
  STATUS_PLACA_NAO_CADASTRADA,
  POLLING_TIMEOUT_SEGUNDOS,
  POLLING_INTERVALO_INICIAL,
  MAX_CONCURRENT_PAGES,
  NUM_WORKERS,
} from './config.js';

export class Orchestrator {
  constructor(page) {
    this._page = page;
    this._consulta = new ConsultaPage(page);
    this._form = new FormPage(page);
    this._popups = new PopupsPage(page);
    this._sheets = new SheetsRepository();
    this._teveErroValor = false;
    this._ultimaAcao = null;
  }

  _registrarAcao(tipo, seletor, valor) {
    this._ultimaAcao = { tipo, seletor, valor };
  }

  async _limparEstado() {
    for (let i = 0; i < 5; i++) {
      const dialogCount = await this._page.locator(
        'div.MuiDialog-container, div[role="dialog"], div[role="presentation"].MuiDialog-root'
      ).count();
      if (dialogCount === 0) break;
      await this._page.keyboard.press('Escape');
      await this._page.waitForTimeout(200);
    }
    await this._page.evaluate(() => {
      document.querySelectorAll('div.MuiDialog-container, div[role="dialog"], .MuiBackdrop-root, .MuiModal-root, div[role="presentation"].MuiDialog-root').forEach(d => d.remove());
    });
    await this._page.waitForTimeout(200);

    const dialogCount = await this._page.locator(
      'div.MuiDialog-container, div[role="dialog"], div[role="presentation"].MuiDialog-root'
    ).count();
    if (dialogCount > 0) {
      logAviso('Fallback: dialogs persistem, recarregando pagina', { carga: this._consulta._cargaNome });
        await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await this._page.waitForTimeout(3000);
    }
  }

  async _tratarPlacaNaoCadastrada(carga) {
    const { nomeArquivo, rowNumber } = carga;
    logAviso('Placa nao cadastrada/encontrada: abortando emissao, indo para a proxima', { carga: nomeArquivo });
    if (rowNumber) {
      await this._sheets.atualizarStatus(rowNumber, STATUS_PLACA_NAO_CADASTRADA);
    }
    await this._popups.fecharPopupSucesso();
    await this._consulta.fecharDialogosComEscape(3);
    await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await this._page.waitForTimeout(2000);
    await this._consulta.navegarParaConsulta();
    await this._consulta.abrirFiltro();
    await this._consulta.definirDatas();
    await this._consulta.clicarAtualizar();
    await this._page.waitForTimeout(1000);
    return 'placa_nao_cadastrada';
  }

  async executarFluxo(carga) {
    const { nomeArquivo, motorista, valor, rowNumber } = carga;
    this._teveErroValor = false;
    this._consulta.definirCarga(nomeArquivo);
    this._form.definirCarga(nomeArquivo);
    this._popups.definirCarga(nomeArquivo);
    logInfo('Iniciando fluxo', { carga: nomeArquivo });

    try {
      await this._limparEstado();

      const linha = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (!linha) {
        logErro('Arquivo não encontrado na tabela', { carga: nomeArquivo });
        return 'erro';
      }

      const status = await this._consulta.lerStatus(linha);
      logInfo(`Status atual: "${status}"`, { carga: nomeArquivo });

      if (status.includes('Aguardando Emissão')) {
        return await this._fluxoAtalho(carga, linha);
      }

      if (status.includes('Carga Finalizada')) {
        logInfo('Carga já finalizada', { carga: nomeArquivo });
        await this._sheets.atualizarStatus(rowNumber, STATUS_FINAL);
        return 'ja_finalizada';
      }

      return await this._fluxoCompleto(carga, linha);
    } catch (err) {
      logErro('Erro no fluxo', { carga: nomeArquivo, erro: err.message });
      return 'erro';
    }
  }

  async _retryComValor1(carga) {
    const { nomeArquivo, motorista, cnpj } = carga;

    await this._popups.fecharErroValor();
    await this._consulta.fecharDialogosComEscape(3);

    const linha = await this._consulta.localizarLinha(nomeArquivo);
    if (!linha) return false;

    this._registrarAcao('clique', 'button Conferir');
    if (!await this._consulta.clicarConferir(linha)) return false;

    if (!await this._consulta.aguardarDialogAbrir()) return false;

    this._registrarAcao('preenchimento', 'input Valor', 1);
    if (!await this._form.preencherValor(1)) return false;
    await this._form.configurarAverbacao();
    await this._form.preencherTransportadora();
    await this._form.preencherAutocomplete('Expedidor*', cnpj || '');
    await this._form.preencherAutocomplete('Motoristas', motorista);
    if (!await this._form.clicarEmitir()) return false;
    await this._popups.clicarSimContinuarAntt();

    if (!await this._popups.clicarSimConfirmacao()) {
      logErro('Falha ao confirmar com valor 1,00', { carga: nomeArquivo });
      return false;
    }

    return true;
  }

  async _fluxoAtalho(carga, linha) {
    const { nomeArquivo, motorista, valor, rowNumber } = carga;
    logInfo('Fluxo atalho: status Aguardando Emissão', { carga: nomeArquivo });

    this._registrarAcao('clique', 'button:has-text("start")');
    if (!await this._consulta.clicarPlay(linha)) {
      logErro('Falha ao clicar play', { carga: nomeArquivo });
      return 'erro';
    }

    await this._page.waitForTimeout(300);
    if (!await this._popups.clicarSimConfirmacao()) {
      if (await this._popups.verificarErroValor()) {
        logAviso('Valor abaixo do mínimo no atalho, tentando recuperação via wizard', { carga: nomeArquivo });
        return await this._fluxoSemValor(carga);
      } else {
        logErro('Falha ao confirmar diálogo', { carga: nomeArquivo });
        return 'erro';
      }
    }

    await this._popups.fecharPopupSucesso();
    await this._consulta.fecharDialogosComEscape();
    await this._page.waitForTimeout(1500);

    const finalizado = await this._aguardarFinalizacao(nomeArquivo);
    if (!finalizado) {
      if (this._teveErroValor) {
        this._teveErroValor = false;
        logAviso('Erro de valor no polling, tentando recuperação via wizard', { carga: nomeArquivo });
        return await this._fluxoSemValor(carga);
      }
      logErro('Status não mudou para Carga Finalizada', { carga: nomeArquivo });
      return 'erro';
    }

    await this._sheets.atualizarStatus(rowNumber, STATUS_FINAL);
    logSucesso('Fluxo atalho concluído', { carga: nomeArquivo });
    return 'ok';
  }

  async _fluxoCompleto(carga, linha = null) {
    const { nomeArquivo, motorista, valor, rowNumber } = carga;
    logInfo('Fluxo completo', { carga: nomeArquivo });

    this._registrarAcao('clique', 'button Conferir');
    if (!await this._consulta.clicarConferir(linha)) {
      logErro('Falha ao clicar em Conferir', { carga: nomeArquivo });
      return 'erro';
    }

    if (!await this._consulta.aguardarDialogAbrir()) {
      logErro('Dialog nao abriu apos Conferir', { carga: nomeArquivo });
      return 'erro';
    }

    const dialogCount = await this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root').count();
    logInfo(`Dialogs abertos: ${dialogCount}`, { carga: nomeArquivo });

    if (dialogCount > 0) {
      const dialogText = await this._page.locator('div[role="dialog"], div[role="presentation"].MuiDialog-root').first().innerText();
      logInfo(`Texto do dialog: "${dialogText.slice(0, 200)}"`, { carga: nomeArquivo });
      try {
        const debugInfo = await this._page.evaluate(() => {
          const dlg = document.querySelector('div[role="dialog"], div[role="presentation"].MuiDialog-root');
          if (!dlg) return null;
          const inputs = dlg.querySelectorAll('input');
          const labels = dlg.querySelectorAll('label');
          return {
            inputsCount: inputs.length,
            inputs: Array.from(inputs).map((inp, i) => ({
              idx: i, type: inp.type, name: inp.name, placeholder: inp.placeholder, id: inp.id
            })),
            labels: Array.from(labels).map(l => l.innerText.substring(0, 50)),
          };
        });
        logInfo(`Debug dialog: ${JSON.stringify(debugInfo)}`, { carga: nomeArquivo });
      } catch {}
    }

    if (await this._popups.verificarNotificacaoPlaca()) {
      logAviso('Placa nao cadastrada/encontrada detectada (fluxo completo)', { carga: nomeArquivo });
      return await this._tratarPlacaNaoCadastrada(carga);
    }

    this._registrarAcao('preenchimento', 'input[type="text"]', valor);
    if (!await this._form.preencherValor(valor)) {
      logAviso('Campo valor não encontrado, abortando (fluxo completo)', { carga: nomeArquivo });
      await this._consulta.fecharDialogosComEscape();
      return 'erro';
    }
    await this._form.configurarAverbacao();
    await this._form.preencherTransportadora();
    await this._form.preencherAutocomplete('Expedidor*', carga.cnpj || '');
    const motoristaEncontrado = await this._form.preencherAutocomplete('Motoristas', motorista);

    this._registrarAcao('clique', 'button:has-text("Emitir")');
    if (!await this._form.clicarEmitir()) {
      logErro('Falha ao clicar Emitir', { carga: nomeArquivo });
      return 'erro';
    }

    if (await this._popups.verificarPlacaRejeitada()) {
      logAviso('Placa rejeitada pelo servidor (fluxo completo), abortando carga', { carga: nomeArquivo });
      await this._sheets.atualizarStatus(rowNumber, STATUS_PLACA_REJEITADA);
      await this._popups.fecharPopupSucesso();
      await this._consulta.fecharDialogosComEscape();
      return 'placa_rejeitada';
    }

    await this._popups.clicarSimContinuarAntt();

    if (!await this._popups.clicarSimConfirmacao()) {
      if (await this._popups.verificarErroValor()) {
        logAviso('Valor abaixo do mínimo detectado, tentando com valor 1,00', { carga: nomeArquivo });
        if (!await this._retryComValor1(carga)) {
          logErro('Falha no retry com valor 1,00', { carga: nomeArquivo });
          return 'erro';
        }
      } else {
        logErro('Falha ao confirmar diálogo', { carga: nomeArquivo });
        return 'erro';
      }
    }

    const finalizado = await this._aguardarFinalizacao(nomeArquivo);
    if (!finalizado) {
      if (this._teveErroValor) {
        this._teveErroValor = false;
        logAviso('Erro de valor detectado no polling (completo), iniciando recuperação', { carga: nomeArquivo });
        return await this._fluxoSemValor(carga);
      }
      logErro('Status não mudou para Carga Finalizada', { carga: nomeArquivo });
      return 'erro';
    }

    let resultado = 'ok';
    let status = STATUS_FINAL;

    if (!motoristaEncontrado) {
      status = STATUS_MOTORISTA_NAO_CADASTRADO;
      logAviso('Motorista não cadastrado no sistema', { carga: nomeArquivo, motorista });
    }

    await this._sheets.atualizarStatus(rowNumber, status);
    logSucesso('Fluxo completo concluído', { carga: nomeArquivo, resultado, motoristaNaoCadastrado: !motoristaEncontrado });
    return resultado;
  }

  async _fluxoSemValor(carga) {
    const { nomeArquivo, motorista, rowNumber } = carga;
    logInfo('Fluxo recuperação: carga sem valor', { carga: nomeArquivo });

    try {
      await this._popups.fecharErroValor();
      await this._consulta.fecharDialogosComEscape(3);

      const linha = await this._consulta.localizarLinha(nomeArquivo);
      if (!linha) {
        logErro('Linha não encontrada para fluxo sem valor', { carga: nomeArquivo });
        return 'erro';
      }

      if (!await this._consulta.clicarOpcoes(linha)) {
        logErro('Falha ao abrir menu de opções', { carga: nomeArquivo });
        return 'erro';
      }

      if (!await this._consulta.clicarConferirCargaMenu()) {
        logErro('Falha ao selecionar Conferir Carga', { carga: nomeArquivo });
        return 'erro';
      }

      for (let i = 0; i < 4; i++) {
        if (!await this._form.clicarProximoWizard()) {
          logAviso(`Falha ao clicar Próximo (passo ${i + 1})`, { carga: nomeArquivo });
        }
      }

      if (!await this._form.clicarCelulaValorWizard()) {
        logAviso('Falha ao clicar na célula de valor do wizard', { carga: nomeArquivo });
      }

      if (!await this._form.preencherValorNoWizard(1)) {
        logAviso('Falha ao preencher valor no wizard', { carga: nomeArquivo });
      }

      await this._form.marcarReplicarValor();

      if (!await this._form.clicarConfirmarValor()) {
        logAviso('Falha ao clicar Confirmar', { carga: nomeArquivo });
      }

      await this._popups.clicarSimConfirmacao();

      await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._page.waitForTimeout(2000);

      const linha2 = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (!linha2) {
        logErro('Linha não encontrada após refresh', { carga: nomeArquivo });
        return 'erro';
      }

      if (!await this._consulta.clicarPlay(linha2)) {
        logErro('Falha ao clicar play no fluxo de recuperação', { carga: nomeArquivo });
        return 'erro';
      }

      await this._popups.clicarSimMaiusculo();
      await this._popups.fecharPopupSucesso();

      const finalizado = await this._aguardarFinalizacao(nomeArquivo);
      if (!finalizado) {
        logErro('Status não mudou para Carga Finalizada (recuperação)', { carga: nomeArquivo });
        return 'erro';
      }

      await this._sheets.atualizarStatus(rowNumber, STATUS_FINAL);
      logSucesso('Fluxo de recuperação concluído', { carga: nomeArquivo });
      return 'ok';
    } catch (err) {
      logErro('Erro no fluxo de recuperação', { carga: nomeArquivo, erro: err.message });
      return 'erro';
    }
  }

  async _aguardarFinalizacao(nomeArquivo) {
    const inicio = Date.now();
    let contador = 0;

    const condicao = async () => {
      contador++;
      await this._consulta.fecharDialogosComEscape();
      await this._consulta.clicarAtualizar();
      await this._page.waitForTimeout(1000);

      const decorrido = ((Date.now() - inicio) / 1000).toFixed(1);
      logInfo(`Polling #${contador} (${decorrido}s) — verificando status`, { carga: nomeArquivo });

      const linha = await this._consulta.localizarLinhaRapido(nomeArquivo);
      if (linha && await this._consulta.statusFinalizado(linha)) {
        logInfo(`Polling #${contador} — Carga Finalizada detectada`, { carga: nomeArquivo });
        return true;
      }

      return false;
    };

    const resultado = await aguardarCondicao(condicao, {
      timeout: POLLING_TIMEOUT_SEGUNDOS * 1000,
      intervaloInicial: POLLING_INTERVALO_INICIAL * 1000,
    });

    if (!resultado) {
      logAviso(`Polling finalizado por timeout (${POLLING_TIMEOUT_SEGUNDOS}s)`, { carga: nomeArquivo });
    }

    return resultado;
  }

  async executarPreenchimento(carga) {
    const { nomeArquivo, motorista, valor, cnpj } = carga;
    this._teveErroValor = false;
    this._consulta.definirCarga(nomeArquivo);
    this._form.definirCarga(nomeArquivo);
    this._popups.definirCarga(nomeArquivo);

    try {
      await this._limparEstado();

      const linha = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (!linha) {
        logAviso('Arquivo nao encontrado na tabela (Fluxo 1)', { carga: nomeArquivo });
        return 'erro';
      }

      const status = await this._consulta.lerStatus(linha);
      logInfo(`Fluxo 1 - Status: "${status}"`, { carga: nomeArquivo });

      if (status.includes('Aguardando Emissão') || status.includes('Aguardando Emissao')) {
        logInfo('Fluxo 1 - Carga ja aguardando emissao, pulando para proxima', { carga: nomeArquivo });
        await this._consulta.fecharDialogosComEscape();
        await this._consulta.clicarAtualizar();
        return 'pulada';
      }

      if (status.includes('Carga Finalizada')) {
        logInfo('Fluxo 1 - Carga ja finalizada, atualizando planilha', { carga: nomeArquivo });
        if (carga.rowNumber) {
          await this._sheets.atualizarStatus(carga.rowNumber, STATUS_FINAL);
        }
        await this._consulta.fecharDialogosComEscape();
        await this._consulta.clicarAtualizar();
        return 'ja_finalizada';
      }

      this._registrarAcao('clique', 'button Conferir');
      if (!await this._consulta.clicarConferir(linha)) {
        logErro('Falha ao clicar Conferir (Fluxo 1)', { carga: nomeArquivo });
        return 'erro';
      }

      if (!await this._consulta.aguardarDialogAbrir()) {
        logErro('Dialog nao abriu apos Conferir (Fluxo 1)', { carga: nomeArquivo });
        return 'erro';
      }

      if (await this._popups.verificarNotificacaoPlaca()) {
        logAviso('Placa nao cadastrada/encontrada detectada (Fluxo 1), emitindo mesmo assim', { carga: nomeArquivo });
        carga.placaNaoCadastrada = true;
      }

      this._registrarAcao('preenchimento', 'input[type="text"]', valor);
      if (!await this._form.preencherValor(valor)) {
        logAviso('Campo valor nao encontrado, abortando (Fluxo 1)', { carga: nomeArquivo });
        await this._consulta.fecharDialogosComEscape(3);
        await this._consulta.clicarAtualizar();
        return 'erro';
      }
      await this._form.configurarAverbacao();
      await this._form.preencherTransportadora();
      await this._form.preencherAutocomplete('Expedidor*', cnpj || '');
      const motoristaEncontrado = await this._form.preencherAutocomplete('Motoristas', motorista);

      if (!motoristaEncontrado) {
        logAviso('Fluxo 1 - Motorista nao cadastrado, emitindo mesmo assim', { carga: nomeArquivo, motorista });
        carga.motoristaNaoCadastrado = true;
      }

      this._registrarAcao('clique', 'button:has-text("EmiteAí")');
      if (!await this._form.clicarEmitir()) {
        logAviso('Falha ao clicar EmiteAi (Fluxo 1)', { carga: nomeArquivo });
        await this._consulta.fecharDialogosComEscape(3);
        await this._consulta.clicarAtualizar();
        return 'erro';
      }

      if (await this._popups.verificarPlacaRejeitada()) {
        logAviso('Placa rejeitada pelo servidor (Fluxo 1), abortando carga', { carga: nomeArquivo });
        if (carga.rowNumber) {
          await this._sheets.atualizarStatus(carga.rowNumber, STATUS_PLACA_REJEITADA);
        }
        await this._popups.fecharPopupSucesso();
        await this._consulta.fecharDialogosComEscape(3);
        await this._consulta.clicarAtualizar();
        return 'placa_rejeitada';
      }

      if (await this._popups.verificarNotificacaoPlaca()) {
        logAviso('Placa nao cadastrada/encontrada detectada apos Emitir (Fluxo 1), emitindo mesmo assim', { carga: nomeArquivo });
        carga.placaNaoCadastrada = true;
      }

      await this._popups.clicarSimContinuarAntt();

      if (!await this._popups.clicarSimConfirmacao()) {
        if (await this._popups.verificarErroValor()) {
          logAviso('Valor abaixo do minimo (Fluxo 1), acionando recuperacao R$1,00', { carga: nomeArquivo });
          const retryOk = await this._retryComValor1(carga);
          if (!retryOk) {
            logAviso('Falha na recuperacao com valor 1,00 (Fluxo 1)', { carga: nomeArquivo });
            await this._consulta.fecharDialogosComEscape(3);
            await this._consulta.clicarAtualizar();
            return 'erro';
          }
          this._teveErroValor = true;
        } else {
          logAviso('Popup de confirmacao nao apareceu (Fluxo 1)', { carga: nomeArquivo });
        }
      }

      if (carga.placaNaoCadastrada && carga.rowNumber) {
        await this._sheets.atualizarStatus(carga.rowNumber, STATUS_PLACA_NAO_CADASTRADA);
        logAviso('Status PLACA_NAO_CADASTRADA gravado na planilha (Fluxo 1)', { carga: nomeArquivo });
      }

      await this._popups.fecharPopupSucesso();
      await this._consulta.fecharDialogosComEscape();
      await this._consulta.clicarAtualizar();
      await this._page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

      logSucesso('Fluxo 1 - Carga preenchida e emitida com sucesso', { carga: nomeArquivo });
      return 'preenchido';
    } catch (err) {
      logErro('Erro no preenchimento (Fluxo 1)', { carga: nomeArquivo, erro: err.message });
      await this._consulta.fecharDialogosComEscape(3);
      await this._consulta.clicarAtualizar();
      return 'erro';
    }
  }

  async executarEmissao(carga) {
    const { nomeArquivo, motorista, rowNumber } = carga;
    this._consulta.definirCarga(nomeArquivo);
    this._popups.definirCarga(nomeArquivo);

    try {
      await this._limparEstado();

      let linha = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (!linha) {
        logAviso('Arquivo nao encontrado na tabela (Fluxo 2)', { carga: nomeArquivo });
        return 'erro';
      }

      let status = await this._consulta.lerStatus(linha);
      logInfo(`Fluxo 2 - Status: "${status}"`, { carga: nomeArquivo });

      let tentativasStatus = 0;
      while (!status && tentativasStatus < 3) {
        tentativasStatus++;
        await this._page.waitForTimeout(2000);
        await this._consulta.clicarAtualizar();
        await this._page.waitForTimeout(1000);
        linha = await this._consulta.pesquisarArquivo(nomeArquivo);
        if (!linha) break;
        status = await this._consulta.lerStatus(linha);
        logInfo(`Fluxo 2 - Status (tentativa ${tentativasStatus}): "${status}"`, { carga: nomeArquivo });
      }

      if (!status) {
        logAviso('Fluxo 2 - Status vazio persistiu, recarregando pagina', { carga: nomeArquivo });
        await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await this._page.waitForTimeout(2000);
        await this._consulta.navegarParaConsulta();
        await this._consulta.abrirFiltro();
        await this._consulta.definirDatas();
        await this._consulta.clicarAtualizar();
        await this._page.waitForTimeout(1000);
        linha = await this._consulta.pesquisarArquivo(nomeArquivo);
        if (linha) {
          status = await this._consulta.lerStatus(linha);
          logInfo(`Fluxo 2 - Status apos reload: "${status}"`, { carga: nomeArquivo });
        }
      }

      if (status.includes('Carga Finalizada')) {
        logInfo('Fluxo 2 - Carga ja finalizada, movendo para verificacao', { carga: nomeArquivo });
        await this._consulta.fecharDialogosComEscape();
        await this._consulta.clicarAtualizar();
        return 'para_verificar';
      }

      if (!status.includes('Aguardando Emissão') && !status.includes('Aguardando Emissao')) {
        logErro(`Status inesperado "${status}" (Fluxo 2)`, { carga: nomeArquivo });
        return 'erro';
      }

      this._registrarAcao('clique', 'button:has-text("start")');
      if (!await this._consulta.clicarPlay(linha)) {
        logErro('Falha ao clicar Play (Fluxo 2)', { carga: nomeArquivo });
        return 'erro';
      }

      if (!await this._popups.clicarSimConfirmacao()) {
        if (await this._popups.verificarErroValor()) {
          logAviso('Valor abaixo do minimo (Fluxo 2)', { carga: nomeArquivo });
          await this._popups.fecharErroValor();
        } else {
          logErro('Falha ao confirmar (Fluxo 2)', { carga: nomeArquivo });
          return 'erro';
        }
      }

      await this._popups.fecharPopupSucesso();
      await this._consulta.fecharDialogosComEscape();

      await this._consulta.clicarAtualizar();
      await this._page.waitForTimeout(1000);
      const linhaPosPlay = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (linhaPosPlay) {
        const statusPosPlay = await this._consulta.lerStatus(linhaPosPlay);
        logInfo(`Fluxo 2 - Status apos play: "${statusPosPlay}"`, { carga: nomeArquivo });
        if (statusPosPlay.includes('Aguardando Emissão') || statusPosPlay.includes('Aguardando Emissao')) {
          logAviso('Fluxo 2 - Play aparentou sucesso mas status nao mudou, recarregando pagina', { carga: nomeArquivo });
          await this._page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await this._page.waitForTimeout(2000);
          await this._consulta.navegarParaConsulta();
          await this._consulta.abrirFiltro();
          await this._consulta.definirDatas();
          await this._consulta.clicarAtualizar();
          await this._page.waitForTimeout(1000);
        }
      }

      logSucesso('Fluxo 2 - Carga emitida, movendo para verificacao (Fila 3)', { carga: nomeArquivo });
      return 'para_verificar';
    } catch (err) {
      logErro('Erro na emissao (Fluxo 2)', { carga: nomeArquivo, erro: err.message });
      await this._consulta.fecharDialogosComEscape(3);
      await this._consulta.clicarAtualizar();
      return 'erro';
    }
  }

  async verificarStatus(carga) {
    const { nomeArquivo } = carga;
    this._consulta.definirCarga(nomeArquivo);

    try {
      await this._popups.fecharPopupSucesso().catch(() => {});
      await this._consulta.fecharDialogosComEscape();

      const linha = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (!linha) return 'nao_encontrado';

      const status = await this._consulta.lerStatus(linha);

      if (status.includes('Carga Finalizada')) return 'finalizado';
      if (status.includes('Aguardando Emissão')) return 'aguardando_emissao';
      return 'em_andamento';
    } catch (err) {
      logErro('Erro ao verificar status (Passada 2)', { carga: nomeArquivo, erro: err.message });
      return 'erro';
    }
  }

  async executarPlay(carga) {
    const { nomeArquivo } = carga;
    this._consulta.definirCarga(nomeArquivo);
    this._popups.definirCarga(nomeArquivo);

    try {
      const linha = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (!linha) return false;

      this._registrarAcao('clique', 'button:has-text("start")');
      if (!await this._consulta.clicarPlay(linha)) return false;

      for (let tentativa = 0; tentativa < 3; tentativa++) {
        const timeout = 20000 + (tentativa * 10000);
        if (await this._popups.clicarSimConfirmacao(timeout)) {
          await this._popups.fecharPopupSucesso();
          return true;
        }
        if (await this._popups.verificarErroValor()) {
          await this._popups.fecharErroValor();
          return true;
        }
        logAviso(`Tentativa ${tentativa + 1}/3: popup de confirmação não detectado`, { carga: nomeArquivo });
        await this._page.waitForTimeout(2000);
      }

      logAviso('Popup de confirmação não apareceu após 3 tentativas', { carga: nomeArquivo });
      return false;
    } catch (err) {
      logErro('Erro ao clicar Play (Passada 2)', { carga: nomeArquivo, erro: err.message });
      return false;
    }
  }

  async verificarCarga(carga) {
    const { nomeArquivo, motorista, rowNumber } = carga;
    this._consulta.definirCarga(nomeArquivo);

    try {
      await this._limparEstado();

      const linha = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (!linha) {
        logAviso('Arquivo nao encontrado na verificacao (Fluxo 3)', { carga: nomeArquivo });
        return 'nao_encontrado';
      }

      const status = await this._consulta.lerStatus(linha);
      logInfo(`Fluxo 3 - Status real: "${status}"`, { carga: nomeArquivo });

      if (status.includes('Carga Finalizada')) {
        let statusFinal = STATUS_FINAL;
        let resultado = 'ok';
        if (carga.placaNaoCadastrada) {
          statusFinal = STATUS_PLACA_NAO_CADASTRADA;
          resultado = 'placa_nao_cadastrada';
        } else if (carga.veiculoSemPlaca) {
          statusFinal = STATUS_VEICULO_SEM_PLACA;
          resultado = 'veiculo_sem_placa';
        } else if (carga.motoristaNaoCadastrado) {
          statusFinal = STATUS_MOTORISTA_NAO_CADASTRADO;
          resultado = 'motorista_nao_cadastrado';
        }
        await this._sheets.atualizarStatus(rowNumber, statusFinal);
        logSucesso(`Fluxo 3 - ${statusFinal} escrita na planilha`, { carga: nomeArquivo });
        return resultado;
      }

      if (status.includes('Motorista')) {
        await this._sheets.atualizarStatus(rowNumber, STATUS_MOTORISTA_NAO_CADASTRADO);
        logSucesso('Fluxo 3 - MOTORISTA_NAO_CADASTRADO escrito na planilha', { carga: nomeArquivo });
        return 'motorista_nao_cadastrado';
      }

      if (status.includes('sem placa') || status.includes('Sem Placa')) {
        await this._sheets.atualizarStatus(rowNumber, STATUS_VEICULO_SEM_PLACA);
        logSucesso('Fluxo 3 - VEICULO_SEM_PLACA escrito na planilha', { carga: nomeArquivo });
        return 'veiculo_sem_placa';
      }

      if (status.includes('Aguardando Emissão') || status.includes('Aguardando Emissao')) {
        logAviso('Fluxo 3 - Carga ainda Aguardando Emissao, precisa de play', { carga: nomeArquivo });
        return 'aguardando_play';
      }

      logAviso(`Fluxo 3 - Status nao reconhecido: "${status}"`, { carga: nomeArquivo });
      return 'status_desconhecido';
    } catch (err) {
      logErro('Erro na verificacao (Fluxo 3)', { carga: nomeArquivo, erro: err.message });
      return 'erro';
    }
  }

  async escreverStatusPlanilha(carga) {
    const { nomeArquivo, motorista, rowNumber } = carga;
    this._consulta.definirCarga(nomeArquivo);

    try {
      const linha = await this._consulta.pesquisarArquivo(nomeArquivo);
      if (!linha) {
        logAviso('Linha não encontrada para escrita (Passada 2)', { carga: nomeArquivo });
        return false;
      }

      const status = await this._consulta.lerStatus(linha);

      let statusFinal = STATUS_FINAL;
      let resultado = 'ok';

      if (status.includes('sem placa') || status.includes('Sem Placa')) {
        resultado = 'sem_placa';
        statusFinal = STATUS_VEICULO_SEM_PLACA;
      }

      const motoristaEncontrado = status.toLowerCase().includes('motorista');
      if (motoristaEncontrado) {
        statusFinal = STATUS_MOTORISTA_NAO_CADASTRADO;
      }

      await this._sheets.atualizarStatus(rowNumber, statusFinal);
      logSucesso('Status escrito na planilha (Passada 2)', { carga: nomeArquivo, status: statusFinal });
      return true;
    } catch (err) {
      logErro('Erro ao escrever status (Passada 2)', { carga: nomeArquivo, erro: err.message });
      return false;
    }
  }

  async executar() {
    const cargas = await this._sheets.lerCargasPendentes();

    if (cargas.length === 0) {
      logInfo('Nenhuma carga pendente encontrada');
      return;
    }

    logInfo(`Processando ${cargas.length} carga(s) com ${MAX_CONCURRENT_PAGES} workers`);

    const inicioTotal = Date.now();

    const paceController = new PaceController(null);

    this._pool = new WorkerPool(
      this._page.context(),
      cargas,
      MAX_CONCURRENT_PAGES,
      paceController
    );

    paceController._pool = this._pool;
    paceController._metrics = this._pool.metrics;

    const resultados = await this._pool.executar();

    const tempoTotal = Date.now() - inicioTotal;
    const total = cargas.length;
    const sucesso = resultados.filter(r => r.sucesso).length;
    const falha = resultados.filter(r => !r.sucesso).length;
    const emitidos = resultados.filter(r => r.resultado === 'ok' || r.resultado === 'sem_placa').length;
    const jaFinalizados = resultados.filter(r => r.resultado === 'ja_finalizada').length;
    const erros = resultados.filter(r => r.resultado === 'erro').length;

    console.log(`\n========================================`);
    console.log(`  RESUMO DO PROCESSAMENTO`);
    console.log(`========================================`);
    console.log(`  Total de cargas encontradas:  ${total}`);
    console.log(`  Total de emissões realizadas: ${emitidos}`);
    console.log(`  Total já finalizadas:         ${jaFinalizados}`);
    console.log(`  Total com sucesso:            ${sucesso}`);
    console.log(`  Total de falhas:              ${falha}`);
    console.log(`  Erros detalhados:             ${erros}`);
    console.log(`========================================`);
    console.log(`  MÉTRICAS DE TEMPO`);
    console.log(`  ─────────────────`);
    console.log(`  Tempo total: ${(tempoTotal / 60000).toFixed(1)} min`);
    console.log(`  Workers: ${MAX_CONCURRENT_PAGES}`);
    console.log(`========================================\n`);

    logInfo('Processamento concluído', {
      total,
      emitidos,
      jaFinalizados,
      sucesso,
      falha,
      erros,
      tempoTotal: `${(tempoTotal / 60000).toFixed(1)} min`,
      workers: MAX_CONCURRENT_PAGES,
    });
  }

  async parar() {
    if (this._pool) {
      await this._pool.parar();
    }
  }
}
