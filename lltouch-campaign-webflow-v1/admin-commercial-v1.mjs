const commercialMarkup = `
    <section class="surface" id="llt-commercial-section" aria-labelledby="llt-commercial-title">
      <h2 id="llt-commercial-title">Operação comercial</h2>
      <label for="llt-commercial-select">Campanha salva</label>
      <select id="llt-commercial-select"><option value="">Selecione uma campanha</option></select>
      <div class="actions">
        <button class="alt" type="button" id="llt-commercial-check">Atualizar prontidão e métricas</button>
      </div>
      <p class="subtle" id="llt-commercial-status" role="status" aria-live="polite">Selecione uma campanha para consultar a prontidão.</p>
      <div class="hidden" id="llt-commercial-details">
        <p class="micro" id="llt-commercial-terms" style="margin-top:14px"></p>
        <p class="micro" id="llt-commercial-window"></p>
        <h3>Prontidão e bloqueios</h3>
        <ul id="llt-commercial-blockers"></ul>
        <p class="micro" id="llt-commercial-plan"></p>
        <p class="micro" id="llt-commercial-availability"></p>
        <div id="llt-commercial-review" class="hidden" style="margin-top:18px">
          <h3>Revisão da versão</h3>
          <label style="display:flex;align-items:start;gap:8px"><input type="checkbox" id="llt-commercial-price" style="width:auto;flex:none">Revisei valores, procedimento, validade e condições da oferta.</label>
          <label style="display:flex;align-items:start;gap:8px"><input type="checkbox" id="llt-commercial-clinical" style="width:auto;flex:none">Revisei as afirmações clínicas e o conteúdo gerado.</label>
          <label style="display:flex;align-items:start;gap:8px"><input type="checkbox" id="llt-commercial-images" style="width:auto;flex:none">Conferi as duas imagens e a autorização de uso.</label>
          <label style="display:flex;align-items:start;gap:8px"><input type="checkbox" id="llt-commercial-public" style="width:auto;flex:none">Autorizo esta versão para uso comercial nas páginas públicas da LL Touch.</label>
          <label for="llt-commercial-availability-date">Data para verificar disponibilidade (Massachusetts)</label>
          <input type="date" id="llt-commercial-availability-date" aria-describedby="llt-commercial-availability-note">
          <p class="micro" id="llt-commercial-availability-note">Escolha um dia de segunda a sábado nos próximos 27 dias. A aprovação verifica Ludimilla e Carol nesta data, independentemente do início da publicação.</p>
        </div>
        <p class="micro hidden" id="llt-commercial-schedule-note" style="margin-top:18px"></p>
        <div class="actions" aria-label="Ações da campanha">
          <button type="button" id="llt-commercial-approve" disabled>Aprovar esta versão</button>
          <button type="button" id="llt-commercial-publish" disabled>Publicar agora</button>
          <button type="button" id="llt-commercial-schedule" disabled>Programar publicação</button>
          <button class="alt" type="button" id="llt-commercial-pause" disabled>Pausar</button>
          <button class="alt" type="button" id="llt-commercial-end" disabled>Encerrar</button>
          <button class="alt" type="button" id="llt-commercial-revoke" disabled>Revogar autorização</button>
          <button class="alt" type="button" id="llt-commercial-return_draft" disabled>Reabrir como rascunho</button>
        </div>
        <div class="hidden" id="llt-commercial-confirm-box" style="margin-top:18px">
          <label for="llt-commercial-confirmation" id="llt-commercial-confirm-label"></label>
          <input id="llt-commercial-confirmation" autocomplete="off" maxlength="20">
          <div class="actions">
            <button type="button" id="llt-commercial-confirm">Confirmar ação</button>
            <button class="alt" type="button" id="llt-commercial-cancel">Cancelar</button>
          </div>
        </div>
        <h3 style="margin-top:22px">Resultados registrados em todas as versões</h3>
        <dl id="llt-commercial-metrics" class="grid"></dl>
        <p class="micro">SMS automático de recuperação desativado.</p>
      </div>
    </section>
`;

const authoringMarkup = `
    <div class="grid" style="margin-top:16px">
      <div>
        <label for="llt-service-option">Selecionar procedimento do catálogo</label>
        <select id="llt-service-option"><option value="">Procedimento manual</option></select>
        <p class="micro" id="llt-service-note" role="status">O mapeamento comercial será validado com o plano da campanha.</p>
      </div>
      <div>
        <label for="llt-deposit">Depósito (USD)</label>
        <input id="llt-deposit" type="number" min="0.50" step="0.01" value="25.00" inputmode="decimal">
        <p class="micro">Saldo <output id="llt-balance" for="llt-offer llt-deposit">—</output></p>
      </div>
    </div>`;

const draftScript = String.raw`
const aiPath = '/lltouch/campaigns/admin/api/ai/';
const draftFields = ['treatment','regular','offer','deposit','start','end','desktop','mobile','notes','creative-1','creative-2','creative-3'];
let draftRevision = 0, draftBusy = false, draftLoading = false, signingIn = false;

function draftControls() {
  const locked = draftBusy || draftLoading;
  for (const id of [...draftFields, 'service-option', ...editFields]) $(id).disabled = locked;
  $('drafts').disabled = draftBusy;
  $('generate').disabled = locked || ($('drafts').value !== '' && !selected);
  $('redo').disabled = $('generate').disabled;
  $('save').disabled = locked || !copy;
}

function addDraftOption(campaign) {
  const select = $('drafts');
  const option = [...select.options].find(item => item.value === campaign.campaignKey) || document.createElement('option');
  option.value = campaign.campaignKey;
  option.textContent = campaign.serviceTitle + ' · v' + campaign.version;
  if (!option.parentNode) select.append(option);
}

function resetDraftFields() {
  selected = null;
  copy = null;
  for (const id of draftFields) $(id).value = '';
  $('deposit').value = '25.00';
  commercial.updateBalance();
  commercial.updateService();
  $('preview-wrap').classList.add('hidden');
  fillEdits();
}

async function loadList(keep) {
  const version = draftRevision;
  const result = await request(aiPath + 'drafts');
  if (version !== draftRevision) return;
  const select = $('drafts');
  const previous = keep ?? select.value;
  const option = document.createElement('option');
  option.value = '';
  option.textContent = 'Nova campanha';
  select.replaceChildren(option);
  for (const campaign of result.campaigns || []) addDraftOption(campaign);
  const present = [...select.options].some(item => item.value === previous);
  select.value = present ? previous : '';
  if (keep && present && selected?.campaignKey !== keep) await loadOne(keep);
  else if (!present && previous) await loadOne('');
}

async function loadOne(key) {
  const version = ++draftRevision;
  draftLoading = Boolean(key);
  resetDraftFields();
  draftControls();
  if (!key) return status('Novo rascunho — preencha os campos e gere o conteúdo.');
  status('Carregando o rascunho salvo…');
  try {
    const result = await request(aiPath + 'drafts/' + encodeURIComponent(key));
    if (version !== draftRevision) return;
    const c = result.campaign;
    if (c?.campaignKey !== key || !Number.isSafeInteger(c.version) || c.version < 1) {
      throw Error('O servidor retornou um rascunho inesperado. Selecione-o novamente.');
    }
    const meta = c.marketing?.campaignMeta || {};
    $('treatment').value = c.serviceTitle;
    for (const [id, field] of [['regular','regularPriceCents'],['offer','priceCents'],['deposit','depositCents']]) {
      $(id).value = Number.isSafeInteger(c[field]) ? (c[field] / 100).toFixed(2) : '';
    }
    $('desktop').value = c.desktopUrl || '';
    $('mobile').value = c.mobileUrl || '';
    $('start').value = meta.startDate || '';
    $('end').value = meta.endDate || '';
    for (const [i, id] of ['creative-1','creative-2','creative-3'].entries()) $(id).value = meta.creativeUrls?.[i] || '';
    commercial.updateBalance();
    commercial.updateService();
    selected = { campaignKey: key, version: c.version };
    copy = c.marketing;
    fillEdits();
    const previewed = renderDraftPreview();
    status(previewed ? 'Rascunho carregado. Revise os campos e salve uma nova versão.' :
      'Rascunho carregado. Preencha as informações da oferta para exibir o conteúdo.');
  } catch (error) {
    if (version === draftRevision) status(error.message, true);
  } finally {
    if (version === draftRevision) {
      draftLoading = false;
      draftControls();
    }
  }
}

function renderDraftPreview() {
  if (!copy) return false;
  try { draw(); return true; }
  catch { $('preview-wrap').classList.add('hidden'); return false; }
}

async function editDraft(action) {
  if (draftBusy || draftLoading || ($('drafts').value && !selected)) return;
  const saving = action === 'save-webflow';
  if (saving && !copy) return;
  let brief;
  try {
    brief = data();
    if (saving) applyEdits();
  } catch (error) { return status(error.message, true); }
  const version = draftRevision;
  draftBusy = true;
  draftControls();
  status(saving ? 'Salvando rascunho no Supabase…' : 'Gerando conteúdo da campanha…');
  const payload = saving ? { ...brief, marketing: copy, campaignKey: selected?.campaignKey ?? null,
    expectedVersion: selected?.version ?? null } : brief;
  try {
    const result = await request(aiPath + action, { method: 'POST', body: JSON.stringify(payload) });
    if (version !== draftRevision) return;
    if (!saving) {
      copy = result.marketing;
      fillEdits();
      draw();
      const plan = result.automationPlan;
      status('Campanha gerada. ' + (plan?.mappingStatus === 'local-catalog-match'
        ? 'Serviço identificado no catálogo local · ' + plan.durationMinutes + ' min.'
        : 'Serviço ou pacote exige revisão de mapeamento.') + ' Confira o conteúdo antes de salvar.');
      return;
    }
    if (typeof result.campaignKey !== 'string' || (selected && selected.campaignKey !== result.campaignKey) ||
        !Number.isSafeInteger(result.version) || result.version <= (selected?.version ?? 0)) {
      throw Error('O servidor não confirmou a nova versão. Consulte a lista antes de tentar novamente.');
    }
    selected = { campaignKey: result.campaignKey, version: result.version };
    addDraftOption({ ...selected, serviceTitle: brief.serviceTitle });
    $('drafts').value = selected.campaignKey;
    const saved = 'Rascunho salvo · ' + selected.campaignKey + ' · v' + selected.version + '.';
    status(saved);
    try { await releaseList(selected.campaignKey); }
    catch { if (version === draftRevision) status(saved + ' Atualize a lista de campanhas para consultar a prontidão.'); }
  } catch (error) {
    if (version === draftRevision) status((saving ? 'Falha ao salvar: ' : 'Falha na geração: ') + error.message, true);
  } finally {
    if (version === draftRevision) {
      draftBusy = false;
      draftControls();
    }
  }
}

const editFields = ['edit-head','edit-em','edit-desc','edit-intro'];
$('signin').addEventListener('click', async () => {
  if (signingIn) return;
  const user = $('user').value.trim(), pass = $('pass').value;
  if (!user || !pass) return showLogin('Informe usuário e senha.');
  const credentials = new TextEncoder().encode(user + ':' + pass);
  if (user.includes(':') || credentials.length > 1050) return showLogin('Verifique o formato das credenciais.');
  signingIn = true;
  $('signin').disabled = true;
  showLogin('');
  const version = ++adminSession;
  auth = 'Basic ' + btoa(String.fromCharCode(...credentials));
  $('pass').value = '';
  try {
    await loadList();
    $('drafts').value = '';
    await loadOne('');
    $('login').classList.add('hidden');
    $('workspace').classList.remove('hidden');
    try { await releaseList(); }
    catch { if (version === adminSession) status('Acesso autorizado. Atualize a lista de campanhas para consultar a prontidão.', true); }
    if (version === adminSession) void commercial.loadCatalog();
  } catch (error) {
    if (version === adminSession) {
      auth = '';
      showLogin('Falha na autenticação: ' + error.message);
    }
  } finally {
    if (version === adminSession) {
      signingIn = false;
      $('signin').disabled = false;
    }
  }
});

function showLogin(message) { $('login-message').textContent = message; }

$('signout').addEventListener('click', () => {
  ++adminSession;
  ++draftRevision;
  auth = '';
  signingIn = false;
  $('signin').disabled = false;
  draftBusy = false;
  draftLoading = false;
  $('drafts').value = '';
  resetDraftFields();
  draftControls();
  commercial.reset();
  llCmTestWebhookReset();
  llCmStripeReset();
  releaseReset();
  leadCaptureReset();
  recoveryMessageReset();
  $('workspace').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('user').focus();
});

$('drafts').addEventListener('change', event => { void loadOne(event.target.value); });
for (const id of ['generate','redo']) $(id).addEventListener('click', () => editDraft('generate'));
$('save').addEventListener('click', () => editDraft('save-webflow'));
for (const id of draftFields) $(id).addEventListener('change', renderDraftPreview);
for (const id of editFields) $(id).addEventListener('input', () => { try { applyEdits(); } catch (error) { status(error.message, true); } });
`;

function mountCommercialStudio({ $, request, refreshCampaigns }) {
  const endpoint = '/lltouch/campaigns/admin/api/commercial/';
  const actionConfirmations = {
    approve: 'APROVAR', publish: 'PUBLICAR', schedule: 'PROGRAMAR',
    pause: 'PAUSAR', end: 'ENCERRAR', revoke: 'REVOGAR', return_draft: 'REABRIR'
  };
  const reviewFields = {
    pricingVerified: 'price', clinicalCopyReviewed: 'clinical',
    imagesReviewed: 'images', publicVisibilityAccepted: 'public'
  };
  const phaseLabels = {
    active: 'Em andamento', draft: 'Rascunho', published: 'Publicada', scheduled: 'Programada',
    paused: 'Pausada', ended: 'Encerrada', expired: 'Expirada', archived: 'Arquivada',
    revoked: 'Autorização revogada', 'not-published': 'Aguardando publicação', 'invalid-dates': 'Datas inválidas'
  };
  const metrics = {
    leadsCaptured: 'Leads capturados', contactsSynced: 'Contatos sincronizados',
    reservationsStarted: 'Reservas iniciadas', checkoutsStarted: 'Checkouts iniciados',
    depositsPaid: 'Depósitos pagos', bookingsConfirmed: 'Agendamentos confirmados',
    conversions: 'Leads convertidos com depósito validado', calendarBlocks: 'Bloqueios registrados no Google Calendar',
    expiredReservations: 'Reservas expiradas', integrationFailures: 'Falhas registradas na fila do CRM',
    reconciliationPending: 'Pendências de conciliação'
  };
  const displayTime = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short'
  });
  const nyDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', dateStyle: 'short' });
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
  let state = null;
  let revision = 0;
  let submitting = false;
  let pendingAction = null;
  let catalogRevision = 0;

  const el = id => $('commercial-' + id);
  const canApprove = () => state?.actions?.approve === true && /^[a-f0-9]{64}$/.test(state.reviewToken || '');
  const note = (message, error = false) => {
    el('status').textContent = message;
    el('status').classList.toggle('error', error);
  };

  function renderActions() {
    for (const action of Object.keys(actionConfirmations)) {
      const allowed = action === 'approve' ? canApprove() : state?.actions?.[action] === true;
      el(action).disabled = submitting || !allowed;
    }
    el('review').classList.toggle('hidden', !canApprove());
    el('confirm').disabled = submitting;
    el('cancel').disabled = submitting;
    const start = Date.parse(state?.startsAt);
    el('schedule-note').classList.toggle('hidden', state?.actions?.schedule !== true || !Number.isFinite(start));
    if (Number.isFinite(start)) {
      el('schedule-note').textContent = 'A publicação programada começa em ' + displayTime.format(start) + ' (Massachusetts).';
    }
  }

  function clearConfirmation() {
    pendingAction = null;
    el('confirm-box').classList.add('hidden');
    el('confirmation').value = '';
  }

  function clear() {
    revision += 1;
    state = null;
    submitting = false;
    clearConfirmation();
    el('details').classList.add('hidden');
    const date = el('availability-date');
    date.value = '';
    date.min = nyDate.format(new Date());
    date.max = new Date(Date.parse(date.min + 'T12:00:00Z') + 27 * 86_400_000).toISOString().slice(0, 10);
    for (const field of Object.values(reviewFields)) el(field).checked = false;
    renderActions();
  }

  function reset() {
    clear();
    el('select').value = '';
    note('Selecione uma campanha para consultar a prontidão.');
    catalogRevision += 1;
  }

  function populate(campaigns, keep) {
    const select = el('select');
    const previous = keep || select.value;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecione uma campanha';
    select.replaceChildren(placeholder);
    for (const campaign of campaigns) {
      const option = document.createElement('option');
      option.value = campaign.campaignKey;
      const status = phaseLabels[campaign.status] || campaign.status;
      option.textContent = campaign.serviceTitle + ' · ' + status + ' · v' + campaign.version;
      select.append(option);
    }
    select.value = [...select.options].some(option => option.value === previous) ? previous : '';
    clear();
    note(select.value ? 'Consulte a prontidão da versão selecionada.' : 'Selecione uma campanha para consultar a prontidão.');
  }

  function render() {
    const { version, status, phase, authorization, blockers, plan, startsAt, endsAt, serviceTitle, terms } = state;
    el('details').classList.remove('hidden');
    const schedule = phase === 'scheduled' ? Date.parse(startsAt) : NaN;
    const labels = { approved: 'Versão aprovada', activated: 'Ativação registrada', revoked: 'Autorização revogada' };
    const authorizationLabel = authorization?.active === true ? 'Autorização vigente' : labels[authorization?.state] || 'Sem autorização vigente';
    const displayPhase = phase === 'not-published' ? status :
      phase === 'ended' && authorization?.state !== 'ended' ? 'expired' : phase;
    note('Versão ' + version + ' · ' + (phaseLabels[displayPhase] || phaseLabels[status] || status) +
      ' · ' + authorizationLabel +
      (Number.isFinite(schedule) ? ' · Publicação programada para ' + displayTime.format(schedule) + ' (Massachusetts).' : ''));
    const prices = [terms?.regularPriceCents, terms?.priceCents, terms?.depositCents];
    const validPrices = prices.every(value => Number.isSafeInteger(value) && value >= 0);
    el('terms').textContent = [serviceTitle, validPrices && 'Valor original ' + money.format(prices[0] / 100),
      validPrices && 'Oferta ' + money.format(prices[1] / 100), validPrices && 'Depósito ' + money.format(prices[2] / 100),
      Number.isSafeInteger(terms?.holdMinutes) && 'Reserva temporária de ' + terms.holdMinutes + ' minutos']
      .filter(Boolean).join(' · ');
    const start = Date.parse(startsAt), end = Date.parse(endsAt);
    el('window').textContent = Number.isFinite(start) && Number.isFinite(end)
      ? 'Validade em Massachusetts: ' + displayTime.format(start) + ' até ' + displayTime.format(end) + '.' : '';
    const messages = state.actions?.approve === true && !canApprove()
      ? [...blockers, 'Atualize a prontidão para obter os dados da versão a revisar.'] : blockers;
    const list = el('blockers');
    list.replaceChildren();
    for (const blocker of messages) {
      const item = document.createElement('li');
      item.textContent = typeof blocker === 'string' ? blocker : blocker?.message || blocker?.code || 'Motivo indisponível';
      list.append(item);
    }
    if (!messages.length) {
      const item = document.createElement('li');
      item.textContent = 'Nenhum bloqueio informado para esta versão.';
      list.append(item);
    }
    if (plan?.serviceKey && Number.isSafeInteger(plan.durationMinutes)) {
      const balance = Number.isSafeInteger(plan.balanceCents) ? ' · Saldo ' + money.format(plan.balanceCents / 100) : '';
      const names = { ludimilla: 'Ludimilla', carol: 'Carol' };
      const providers = (plan.providerKeys || []).map(key => names[key]).filter(Boolean);
      el('plan').textContent = plan.serviceKey + ' · ' + plan.durationMinutes + ' min' + balance +
        (providers.length ? ' · ' + providers.join(' e ') : '');
    } else {
      el('plan').textContent = '';
    }
    const sample = authorization?.availability;
    const observedAt = Date.parse(sample?.checkedAt);
    el('availability').textContent = /^\d{4}-\d{2}-\d{2}$/.test(sample?.date || '') && Number.isFinite(observedAt)
      ? 'Data consultada: ' + sample.date.split('-').reverse().join('/') + ' · verificação registrada em ' + displayTime.format(observedAt) + ' (Massachusetts).'
      : '';
    const summary = el('metrics');
    summary.replaceChildren();
    for (const [key, label] of Object.entries(metrics)) {
      const metric = document.createElement('div');
      const term = document.createElement('dt');
      const count = document.createElement('dd');
      term.className = 'micro';
      term.textContent = label;
      count.style.margin = '0';
      const value = state.metrics?.[key];
      count.textContent = Number.isSafeInteger(value) && value >= 0 ? String(value) : 'Indisponível';
      metric.append(term, count);
      summary.append(metric);
    }
    renderActions();
  }

  async function check() {
    const key = el('select').value;
    clear();
    if (!key) return note('Selecione uma campanha para consultar a prontidão.');
    const sequence = revision;
    note('Consultando a versão, as permissões e os resultados…');
    try {
      const result = await request(endpoint + encodeURIComponent(key));
      if (revision !== sequence) return;
      if (result.campaignKey !== key || !Number.isSafeInteger(result.version) || result.version < 1 || !Array.isArray(result.blockers)) {
        throw Error('O servidor retornou dados incompletos para esta campanha.');
      }
      state = result;
      render();
    } catch (error) {
      if (revision === sequence) note('Falha na consulta: ' + error.message, true);
    }
  }

  function prepare(action) {
    if (submitting || state?.actions?.[action] !== true || (action === 'approve' && !canApprove())) return;
    pendingAction = action;
    el('confirm-label').textContent = 'Versão ' + state.version + '. Digite ' + actionConfirmations[action] + ' para confirmar.';
    el('confirm-box').classList.remove('hidden');
    el('confirmation').value = '';
    el('confirmation').focus();
  }

  async function mutate() {
    const action = pendingAction;
    if (submitting || state?.actions?.[action] !== true) return;
    const sequence = revision;
    const key = state.campaignKey;
    const body = { action, expectedVersion: state.version, expectedRevision: state.authorization?.revision ?? 0 };
    body.confirmation = el('confirmation').value;
    if (body.confirmation !== actionConfirmations[action]) return note('Verifique o texto de confirmação.', true);
    if (action === 'approve') {
      if (!canApprove()) return note('Atualize a prontidão antes de aprovar.', true);
      body.reviewToken = state.reviewToken;
      body.review = Object.fromEntries(Object.entries(reviewFields)
        .map(([name, id]) => [name, el(id).checked]));
      if (Object.values(body.review).some(checked => !checked)) {
        return note('Conclua toda a revisão antes de aprovar a versão.', true);
      }
      const date = el('availability-date');
      body.availabilityDate = date.value;
      if (date.value < date.min || date.value > date.max || new Date(date.value + 'T12:00:00Z').getUTCDay() === 0) {
        return note('Escolha um dia de segunda a sábado no intervalo da consulta.', true);
      }
    }
    if (action === 'schedule') {
      if (!(Date.parse(state.startsAt) > Date.now())) return note('A programação exige uma data de início futura.', true);
      body.scheduledAt = state.startsAt;
    }
    submitting = true;
    el('select').disabled = true;
    el('check').disabled = true;
    renderActions();
    try {
      await request(endpoint + encodeURIComponent(key), { method: 'POST', body: JSON.stringify(body) });
      if (revision !== sequence) return;
      if (['publish','schedule','pause','end','return_draft'].includes(action)) {
        try { await refreshCampaigns(key, action); }
        catch { /* The mutation succeeded. Fetch the current state directly. */ }
      }
      if (el('select').value === key) await check();
    } catch (error) {
      if (revision !== sequence) return;
      await check();
      if (revision === sequence + 1) note('Não foi possível concluir a ação: ' + error.message, true);
    } finally {
      submitting = false;
      el('select').disabled = false;
      el('check').disabled = false;
      renderActions();
    }
  }

  function updateBalance() {
    const offer = $('offer').value;
    const deposit = $('deposit').value;
    const balance = Math.round(Number(offer) * 100) - Math.round(Number(deposit) * 100);
    $('balance').textContent = Number(deposit) >= 0.5 && balance >= 0 ? money.format(balance / 100) : '—';
  }

  function updateService() {
    const title = $('treatment').value.trim().toLowerCase();
    const options = [...$('service-option').options];
    const selected = options.find(option => option.value &&
      [option.value.toLowerCase(), option.dataset.label?.toLowerCase()].includes(title));
    $('service-option').value = selected?.value || '';
    $('service-note').textContent = selected?.dataset.duration
      ? 'Catálogo local: uma sessão de ' + selected.dataset.duration + ' minutos. A agenda depende da prontidão comercial.'
      : 'O mapeamento comercial será validado com o plano da campanha.';
  }

  async function loadCatalog() {
    const sequence = ++catalogRevision;
    try {
      const result = await request('/lltouch/campaigns/admin/api/editor/services');
      if (sequence !== catalogRevision) return;
      const select = $('service-option');
      for (const option of [...select.options].slice(1)) option.remove();
      for (const service of result.services || []) {
        const option = document.createElement('option');
        option.value = service.key;
        option.textContent = service.label + (service.durationMinutes ? ' · ' + service.durationMinutes + ' min' : '');
        option.dataset.label = service.label;
        if (service.durationMinutes) option.dataset.duration = String(service.durationMinutes);
        select.append(option);
      }
      updateService();
    } catch {
      if (sequence === catalogRevision) $('service-note').textContent = 'Catálogo temporariamente indisponível.';
    }
  }

  $('service-option').addEventListener('change', event => {
    const option = event.target.selectedOptions[0];
    if (option?.dataset.label) $('treatment').value = option.dataset.label;
    updateService();
  });
  $('treatment').addEventListener('input', updateService);
  $('offer').addEventListener('input', updateBalance);
  $('deposit').addEventListener('input', updateBalance);
  el('check').addEventListener('click', check);
  el('select').addEventListener('change', check);
  el('confirm').addEventListener('click', mutate);
  el('cancel').addEventListener('click', clearConfirmation);
  for (const action of Object.keys(actionConfirmations)) el(action).addEventListener('click', () => prepare(action));
  return { loadCatalog, populate, reset, updateBalance, updateService };
}

export function addCommercialControls(html) {
  function replace(original, replacement) {
    if (!html.includes(original)) throw Error('Campaign Studio template changed: ' + original);
    html = html.replace(original, () => replacement);
  }

  replace('<div class="surface" id="llt-release-section">', commercialMarkup + '\n    <div class="surface" id="llt-release-section">');
  replace('<div class="mini-tiles"><span>Depósito padrão: $25</span><span>Validade por data: Massachusetts</span><span>IA em inglês</span><span>Revisão humana</span></div>', authoringMarkup);
  replace('id="llt-signin">Entrar</button></div>', 'id="llt-signin">Entrar</button></div><p class="micro" id="llt-login-message" role="status" aria-live="polite"></p>');
  replace('<div class="draft-tag">IA + publicação visual</div>', '<div class="draft-tag">Administração de campanhas</div>');
  replace('A publicação visual fica disponível após validação, sem checkout.', 'Confira a prontidão antes de aprovar e publicar uma versão.');
  replace('A publicação visual exige uma segunda confirmação e nunca habilita cobranças nem agendamentos.', 'Cada versão comercial exige revisão e autorização explícita no painel.');
  replace('Publique apenas preços e textos aprovados.', 'Use esta seção para a modalidade somente visual.');
  replace('GoHighLevel, pagamentos e reservas permanecem desligados nesta fase.', 'Para a modalidade comercial, confira as permissões na operação comercial.');
  replace('O envio segue bloqueado; Stripe, reservas e SMS permanecem desligados.', 'Consulte a operação comercial para verificar as permissões da versão.');
  replace("const API='https://stripe-checkout-1.onrender.com',EL=", 'const EL=');
  replace("let auth='',copy=null,selected=null,busy=false;", "let auth='',copy=null,selected=null,adminSession=0;");
  replace("const r=await fetch(API+path,", "const session=adminSession;const r=await fetch(path,");
  replace("throw Error(v.error||('HTTP '+r.status));return v;", "throw Error((path.startsWith('/lltouch/campaigns/admin/api/commercial/')&&v.message)||v.error||('HTTP '+r.status));if(session!==adminSession)throw Error('A sessão administrativa foi encerrada.');return v;");
  replace("priceCents=cents($('offer').value),startDate=", "priceCents=cents($('offer').value),depositCents=cents($('deposit').value),startDate=");
  replace('regularPriceCents<priceCents||priceCents<2500)', 'regularPriceCents<=priceCents||depositCents<50||priceCents<depositCents)');
  replace('O preço promocional deve ser pelo menos US$ 25 e não pode superar o preço original.', 'Informe um depósito de pelo menos US$ 0,50 que caiba na oferta. O preço promocional deve ser menor que o original.');
  replace('depositCents:2500,startDate', 'depositCents,startDate');
  replace('type="number" min="25" step="0.01" placeholder="497.00"', 'type="number" min="0.50" step="0.01" placeholder="497.00"');
  const draftStart = html.indexOf('async function loadList(keep){');
  const draftEnd = html.indexOf('// Stage 03B-1 release controls:', draftStart);
  if (draftStart < 0 || draftEnd < 0) throw Error('Campaign Studio authoring template changed.');
  html = html.slice(0, draftStart) + draftScript + '\n' + html.slice(draftEnd);
  replace('leadCapturePopulate(data.campaigns||[]);', 'leadCapturePopulate(data.campaigns||[]);\n  commercial.populate(data.campaigns||[],keep);');
  replace("$('release-refresh').addEventListener(", `const commercial=(${mountCommercialStudio.toString()})({$,request,
    async refreshCampaigns(key, action) {
      await releaseList(key);
      if (['publish','schedule','end','return_draft'].includes(action)) await loadList();
    }});
$('release-refresh').addEventListener(`);
  return html;
}
