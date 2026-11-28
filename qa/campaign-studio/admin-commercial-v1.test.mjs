import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Script } from 'node:vm';
import { addCommercialControls } from '../../lltouch-campaign-webflow-v1/admin-commercial-v1.mjs';

const source = readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
const template = source.split('const LL_CM_WEBFLOW_IFRAME_HTML = Buffer.from([')[1].split("].join(''), 'base64')")[0];
const baseHtml = Buffer.from([...template.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map(match => match[1]).join(''), 'base64').toString('utf8');
const html = addCommercialControls(baseHtml);
const prefix = '/lltouch/campaigns/admin';
const host = 'https://campaign-studio.test';
const webflowFixture = 'https://lltouch.com/campaign-studio-isolated-qa';
const key = 'hydrafacial-piloto-qa';
const authoredKey = 'campaign-qa-authoring';

test('existing admin iframe composes a single nonce-protected browser script', () => {
  const scripts = [...html.matchAll(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0][1]));
  for (const id of ['llt-commercial-section', 'llt-deposit', 'llt-service-option', 'llt-release-section', 'llt-leads-section']) {
    assert.equal(html.split(`id="${id}"`).length, 2, id);
  }
});

test('existing admin iframe uses versioned commercial controls and preserves authoring in an offline browser', async t => {
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require(process.env.LL_CM_UI_PLAYWRIGHT || 'playwright')); }
  catch (error) {
    if (process.env.LL_CM_UI_PLAYWRIGHT) throw error;
    return t.skip('Playwright is unavailable. Set LL_CM_UI_PLAYWRIGHT to an installed module.');
  }
  const browser = await chromium.launch({
    executablePath: process.env.LL_CM_UI_CHROMIUM,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking', '--disable-component-update', '--disable-sync']
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 900 } });
  const posts = [];
  const authored = [];
  const otherOrigins = [];
  const unknown = [];
  const errors = [];
  const start = '2099-07-15T04:00:00.000Z';
  const end = '2099-08-15T04:00:00.000Z';
  let now = '2099-07-10T12:00:00.000Z';
  let version = 2;
  let revision = 0;
  let authorizationState = 'unapproved';
  let status = 'draft';
  let editedDraft = null;
  let failCampaignList = true;
  let readiness = 'closed';
  let reviewToken = 'a'.repeat(64);
  let rejectStaleReview = true;
  let delayedAuthoringRead;
  let generatedCount = 0;
  const marketing = {
    headline: 'HydraFacial Special', headlineEm: 'A moment for your skin',
    description: 'Synthetic campaign for browser QA.', featureIntro: 'Browser QA.'
  };
  const terms = { regularPriceCents: 34900, priceCents: 14900, depositCents: 2500, holdMinutes: 10 };
  const plan = { serviceKey: 'hydrafacial', durationMinutes: 75, balanceCents: 12400, providerKeys: ['ludimilla', 'carol'] };
  const hero = { desktopUrl: 'https://synthetic-media.invalid/desktop.jpg', mobileUrl: 'https://synthetic-media.invalid/mobile.jpg' };

  const campaign = () => ({ campaignKey: key, status, version, serviceTitle: 'HydraFacial' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === webflowFixture) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style>
        <iframe id="studio" title="LL Touch Campaign Studio" src="${host}${prefix}/webflow-studio"></iframe>
        <script>addEventListener('message',event=>{
          if(event.origin==='${host}'&&event.source===document.getElementById('studio').contentWindow&&event.data?.type==='lltouch-campaign-studio-height'){
            document.body.dataset.studioHeight=event.data.height;
          }
        });</script>` });
    }
    if (url.origin !== host) {
      otherOrigins.push({ origin: url.origin, type: request.resourceType() });
      return route.abort();
    }
    const path = url.pathname;
    if (path === prefix + '/webflow-studio') {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html.replace('__NONCE__', 'qa-nonce'), headers: {
        'Content-Security-Policy': "default-src 'none'; script-src 'nonce-qa-nonce'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://lltouch.com https://www.lltouch.com",
        'Referrer-Policy': 'no-referrer'
      } });
    }
    assert.equal(request.headers().authorization, 'Basic ' + Buffer.from('isolated-qa:isolated-qa-placeholder').toString('base64'));
    const json = data => route.fulfill({ json: { ok: true, ...data } });
    const reject = (status, data) => route.fulfill({ status, json: { ok: false, ...data } });
    if (path === prefix + '/api/ai/drafts') return json({ campaigns: [
      ...(status === 'draft' ? [campaign()] : []), ...(editedDraft ? [editedDraft] : [])
    ] });
    if (path === prefix + '/api/ai/drafts/' + authoredKey) {
      if (delayedAuthoringRead) await delayedAuthoringRead;
      return json({ campaign: editedDraft });
    }
    if (path === prefix + '/api/ai/drafts/' + key) return json({ campaign: {
      ...terms, ...hero, ...campaign(), marketing: { ...marketing, headline: 'HydraFacial de referência',
        campaignMeta: { startDate: '2099-07-15', endDate: '2099-08-14' } }
    } });
    if (path === prefix + '/api/ai/generate') {
      generatedCount++;
      assert.deepEqual(request.postDataJSON(), { serviceTitle: 'HydraFacial', regularPriceCents: 34900,
        priceCents: 14900, depositCents: 2500, startDate: '2099-07-15', endDate: '2099-08-14',
        ...hero, creativeUrls: [], notes: '' });
      return json({ marketing, automationPlan: { mappingStatus: 'local-catalog-match', durationMinutes: 75 } });
    }
    if (path === prefix + '/api/ai/save-webflow') {
      const fields = request.postDataJSON();
      authored.push(fields);
      editedDraft = { ...fields, campaignKey: authoredKey, version: (editedDraft?.version || 0) + 1, status: 'draft',
        marketing: { ...fields.marketing, campaignMeta: { startDate: fields.startDate, endDate: fields.endDate } } };
      return json({ campaignKey: editedDraft.campaignKey, version: editedDraft.version, status: 'draft' });
    }
    if (path === prefix + '/api/campaigns') {
      if (editedDraft && failCampaignList) {
        failCampaignList = false;
        return reject(503, { error: 'Lista temporariamente indisponível.' });
      }
      return json({ campaigns: [campaign(), ...(editedDraft ? [editedDraft] : [])] });
    }
    if (path === prefix + '/api/editor/services') return json({ services: [{ key: 'hydrafacial', label: 'HydraFacial', durationMinutes: 75 }] });
    if (path === prefix + '/api/commercial/' + key) {
      if (request.method() === 'GET') {
        const scheduleState = start > now ? 'scheduled' : 'active';
        const ending = authorizationState === 'ended';
        const active = status === 'published' && scheduleState === 'active' && authorizationState === 'activated';
        const approved = authorizationState === 'approved';
        const ready = readiness !== 'closed';
        return json({ ...campaign(), phase: ending ? 'ended' : status === 'published' ? scheduleState : 'not-published',
          startsAt: start, endsAt: end, timezone: 'America/New_York', terms, plan, ready,
          reviewToken: readiness === 'token-missing' ? null : reviewToken,
          authorization: { active, revision, state: authorizationState, availability: revision ? {
            date: '2099-07-16', checkedAt: now, providers: plan.providerKeys,
            sources: ['Vagaro', 'Google Calendar', 'Supabase'], slots: 2
          } : null },
          blockers: ready ? [] : [{ code: 'CM_COMMERCIAL_GLOBAL_LOCK', message: 'A liberação comercial global está desabilitada.' }],
          actions: { approve: ready && status === 'draft' && !approved, publish: approved && scheduleState === 'active',
            schedule: approved && scheduleState === 'scheduled', pause: status === 'published', end: !ending && status === 'published',
            revoke: approved || authorizationState === 'activated', return_draft: !ending && status === 'paused' },
          metrics: { leadsCaptured: 3, contactsSynced: 0, reservationsStarted: 2, checkoutsStarted: 1, depositsPaid: 1,
            bookingsConfirmed: null, conversions: 1, calendarBlocks: 1, expiredReservations: 1, integrationFailures: 0, reconciliationPending: 0 } });
      }
      const body = request.postDataJSON();
      posts.push(body);
      assert.equal(body.expectedVersion, version);
      assert.equal(body.expectedRevision, revision);
      if (body.action === 'approve') {
        assert.equal(body.reviewToken, reviewToken);
        if (rejectStaleReview) {
          rejectStaleReview = false;
          reviewToken = 'b'.repeat(64);
          return reject(409, { error: 'CM_COMMERCIAL_REVIEW_STALE', message: 'Os termos ou as imagens mudaram. Revise a versão atual.' });
        }
      }
      revision++;
      if (body.action === 'approve') authorizationState = 'approved';
      if (['schedule', 'publish'].includes(body.action)) { status = 'published'; authorizationState = 'activated'; version++; }
      if (body.action === 'revoke') authorizationState = 'revoked';
      if (body.action === 'pause') { status = 'paused'; authorizationState = 'revoked'; version++; }
      if (body.action === 'end') { status = 'paused'; authorizationState = 'ended'; version++; }
      if (body.action === 'return_draft') { status = 'draft'; authorizationState = 'invalidated'; version++; }
      return json(campaign());
    }
    unknown.push(path);
    return route.abort();
  });

  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(now));
  page.on('pageerror', error => errors.push(error.message));
  const frame = page.frameLocator('#studio');
  const field = id => frame.locator('#llt-' + id);
  const control = id => field('commercial-' + id);
  async function action(id, phrase, expectedText) {
    await control(id).click();
    await control('confirmation').fill(phrase);
    await control('confirm').click();
    await control('status').filter({ hasText: expectedText }).waitFor();
  }
  async function review(date = '2099-07-16') {
    for (const id of ['price', 'clinical', 'images', 'public']) await control(id).check();
    await control('availability-date').fill(date);
  }
  await page.goto(webflowFixture);
  await page.waitForFunction(() => Number(document.body.dataset.studioHeight) > 0);
  await field('user').fill('isolated-qa');
  await field('pass').fill('isolated-qa-placeholder');
  await field('signin').click();
  await field('service-option').locator('option[value="hydrafacial"]').waitFor({ state: 'attached' });
  await field('service-option').selectOption('hydrafacial');
  assert.equal(await field('treatment').inputValue(), 'HydraFacial');
  await field('offer').fill('149');
  await field('deposit').fill('25');
  assert.match(await field('balance').textContent(), /124,00/);
  await field('regular').fill('349');
  await field('start').fill('2099-07-15');
  await field('end').fill('2099-08-14');
  await field('desktop').fill('https://synthetic-media.invalid/desktop.jpg');
  await field('mobile').fill('https://synthetic-media.invalid/mobile.jpg');
  await field('generate').click();
  await field('preview-wrap').waitFor();
  await field('save').click();
  await field('status').filter({ hasText: 'Rascunho salvo' }).waitFor();
  assert.equal(authored[0].campaignKey, null);
  assert.equal(authored[0].depositCents, 2500);
  await field('status').filter({ hasText: 'Atualize a lista de campanhas' }).waitFor();
  assert.equal(await field('drafts').inputValue(), authoredKey);
  await field('edit-head').fill('HydraFacial · campanha sintética revisada');
  await field('save').click();
  await field('status').filter({ hasText: 'Rascunho salvo · ' + authoredKey + ' · v2.' }).waitFor();
  assert.equal(authored[1].expectedVersion, 1);
  assert.equal(authored[1].campaignKey, authoredKey);
  assert.equal(authored[1].depositCents, 2500);
  assert.match(authored[1].marketing.headline, /revisada/);
  assert.equal(generatedCount, 1);

  let finishDelayedRead;
  delayedAuthoringRead = new Promise(resolve => { finishDelayedRead = resolve; });
  await field('drafts').selectOption('');
  const oldRequest = page.waitForRequest(request => request.url().endsWith('/drafts/' + authoredKey));
  await field('drafts').selectOption(authoredKey);
  await oldRequest;
  assert.equal(await field('save').isDisabled(), true);
  await field('drafts').selectOption(key);
  await field('p-head').filter({ hasText: 'HydraFacial de referência' }).waitFor();
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/drafts/' + authoredKey));
  finishDelayedRead();
  await (await oldResponse).finished();
  await field('p-head').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await field('p-head').textContent(), 'HydraFacial de referência');
  assert.equal(await field('drafts').inputValue(), key);

  await control('select').selectOption(key);
  await control('blockers').filter({ hasText: 'A liberação comercial global está desabilitada.' }).waitFor();
  assert.equal(await control('approve').isDisabled(), true);
  assert.match(await control('terms').textContent(), /Valor original.*349,00.*149,00.*25,00.*10 minutos/);
  assert.match(await control('plan').textContent(), /Ludimilla e Carol/);
  assert.match(await control('plan').textContent(), /124,00/);
  assert.match(await control('window').textContent(), /Massachusetts/);
  assert.equal(await control('publish').isDisabled(), true);
  assert.match(await control('metrics').textContent(), /Agendamentos confirmadosIndisponível/);
  assert.match(await control('metrics').textContent(), /Contatos sincronizados0/);
  assert.match(await control('metrics').textContent(), /Leads convertidos com depósito validado1/);
  readiness = 'token-missing';
  await control('check').click();
  await control('blockers').filter({ hasText: 'Atualize a prontidão para obter os dados da versão a revisar.' }).waitFor();
  assert.equal(await control('approve').isDisabled(), true);
  readiness = 'open';
  await control('check').click();
  await control('blockers').filter({ hasText: 'Nenhum bloqueio informado' }).waitFor();
  await action('approve', 'INVALIDO', 'Verifique o texto');
  assert.equal(posts.length, 0);
  await action('approve', 'APROVAR', 'Conclua toda a revisão');
  assert.equal(posts.length, 0);
  await review('2099-07-12');
  await action('approve', 'APROVAR', 'Escolha um dia de segunda a sábado');
  assert.equal(posts.length, 0);
  await control('availability-date').fill('2099-07-16');
  await action('approve', 'APROVAR', 'Os termos ou as imagens mudaram.');
  assert.equal(posts[0].reviewToken, 'a'.repeat(64));
  assert.equal(await control('price').isChecked(), false);
  await review();
  await action('approve', 'APROVAR', 'Versão aprovada');
  assert.equal(posts[1].availabilityDate, '2099-07-16');
  assert.equal(posts[1].reviewToken, 'b'.repeat(64));
  assert.deepEqual(posts[1].review, { pricingVerified: true, clinicalCopyReviewed: true, imagesReviewed: true, publicVisibilityAccepted: true });
  assert.match(await control('availability').textContent(), /16\/07\/2099/);
  await action('schedule', 'PROGRAMAR', 'Programada');
  assert.equal(posts[2].scheduledAt, start);
  assert.equal(await field('drafts').inputValue(), '');
  await action('revoke', 'REVOGAR', 'Autorização revogada');
  await action('pause', 'PAUSAR', 'Pausada');
  await action('return_draft', 'REABRIR', 'Versão 5');

  now = '2099-07-16T12:00:00.000Z';
  await page.clock.setFixedTime(new Date(now));
  await control('check').click();
  await control('status').filter({ hasText: 'Rascunho' }).waitFor();
  await review();
  await action('approve', 'APROVAR', 'Versão aprovada');
  assert.equal(await control('schedule').isDisabled(), true);
  await action('publish', 'PUBLICAR', 'Em andamento');
  assert.match(await control('status').textContent(), /Autorização vigente/);
  await action('end', 'ENCERRAR', 'Encerrada');
  assert.equal(await control('return_draft').isDisabled(), true);
  assert.deepEqual(posts.map(post => post.action), ['approve', 'approve', 'schedule', 'revoke', 'pause', 'return_draft', 'approve', 'publish', 'end']);

  for (const width of [1200, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await control('section').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `viewport ${width}`);
  }
  assert.equal(await frame.getByRole('heading', { name: 'Campaign Studio' }).count(), 1);
  assert.equal(await frame.getByRole('img', { name: 'LL Touch Advanced Aesthetics' }).count(), 1);
  assert.equal(await control('section').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 254, 250)');
  assert.equal(await control('title').evaluate(element => getComputedStyle(element).color), 'rgb(74, 52, 42)');
  await field('signout').click();
  assert.equal(await control('section').isVisible(), false);
  assert.equal(await field('edit-head').inputValue(), '');
  assert.deepEqual(unknown, []);
  assert.deepEqual(errors, []);
  assert.ok(otherOrigins.every(request => ['stylesheet', 'image', 'font'].includes(request.type)));
});
