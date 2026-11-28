import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { networkInterfaces } from 'node:os';
import test from 'node:test';
import express from 'express';
import Stripe from 'stripe';

const basePath = '/lltouch/campaigns';
const adminUser = 'synthetic-qa-admin';
const adminPassword = 'synthetic-qa-admin-password';
const adminAuth = 'Basic ' + Buffer.from(`${adminUser}:${adminPassword}`).toString('base64');
const commercialReviewToken = 'a'.repeat(64);
const supabaseOrigin = 'https://synthetic-supabase.invalid';
const stripeMock = Symbol.for('lltouch.qa.stripe');
const nativeFetch = globalThis.fetch;
const entrypoint = new URL('../../index.js', import.meta.url);
let run = 0;

function json(data, status = 200) {
  return Response.json(data, { status });
}

async function withApp({ environment = {}, mocks = {}, stripe = {} }, callback) {
  const externalInterfaces = Object.values(networkInterfaces()).flat().filter(item => !item.internal);
  assert.deepEqual(externalInterfaces, [], 'Run this suite in a container with --network none');

  const originalEnvironment = { ...process.env };
  const originalListen = express.application.listen;
  const originalSetInterval = globalThis.setInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const networkCalls = [];
  const unexpectedCalls = [];
  const stripeCalls = [];
  const timers = [];
  let server;

  const stripeMethod = operation => (...args) => {
    stripeCalls.push({ operation, args });
    if (!stripe[operation]) {
      unexpectedCalls.push(operation);
      throw new Error(`Unexpected Stripe operation ${operation}`);
    }
    return stripe[operation](...args);
  };
  globalThis[stripeMock] = class {
    checkout = { sessions: {
      create: stripeMethod('checkout.sessions.create'),
      retrieve: stripeMethod('checkout.sessions.retrieve'),
      expire: stripeMethod('checkout.sessions.expire'),
      listLineItems: stripeMethod('checkout.sessions.listLineItems')
    } };
    webhooks = { constructEvent: stripeMethod('webhooks.constructEvent') };
    paymentIntents = { retrieve: stripeMethod('paymentIntents.retrieve') };
    charges = { retrieve: stripeMethod('charges.retrieve') };
  };

  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'stripe' || specifier === 'dotenv') {
        const source = specifier === 'stripe'
          ? 'export default class { constructor(...args) { return new globalThis[Symbol.for("lltouch.qa.stripe")](...args) } }'
          : 'export default {config: () => ({parsed: {}})}';
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
      return next(specifier, context);
    }
  });

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    networkCalls.push({ method: request.method, url });
    const route = mocks[`${request.method} ${url.origin}${url.pathname}`];
    if (route) return route(request, url);
    unexpectedCalls.push(`${request.method} ${url.origin}${url.pathname}`);
    throw new Error(`Unexpected outbound request to ${url.origin}${url.pathname}`);
  };
  express.application.listen = function (_port, callback) {
    server = originalListen.call(this, 0, '127.0.0.1', callback);
    return server;
  };

  function interceptTimer(original, kind) {
    return (callback, delay, ...args) => {
      if (new Error().stack.split('\n')[2]?.includes(entrypoint.href + '?run=')) {
        timers.push({ kind, delay, callback: () => callback(...args) });
        return { unref() {} };
      }
      return original(callback, delay, ...args);
    };
  }
  globalThis.setInterval = interceptTimer(originalSetInterval, 'interval');
  globalThis.setTimeout = interceptTimer(originalSetTimeout, 'timeout');

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      STRIPE_SECRET_KEY: 'sk_test_synthetic_local_only',
      SUPABASE_URL: supabaseOrigin,
      SUPABASE_KEY: 'synthetic-local-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-local-service-role',
      LLTOUCH_CM_ADMIN_USER: adminUser,
      LLTOUCH_CM_ADMIN_PASSWORD: adminPassword,
      ...environment
    });

    const moduleUrl = new URL(entrypoint);
    moduleUrl.searchParams.set('run', String(++run));
    await import(moduleUrl);
    assert.ok(server, 'Express entry point started a local server');
    if (!server.listening) await once(server, 'listening');

    async function request(path, { body, ...init } = {}) {
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}${path}`, {
        ...init,
        method: init.method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const type = response.headers.get('content-type') || '';
      return { status: response.status, headers: response.headers,
        body: type.includes('json') ? await response.json() : await response.text() };
    }

    await callback({ request, networkCalls, stripeCalls, timers });
    assert.deepEqual(unexpectedCalls, [], 'Every attempted external action must have an explicit fixture');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    express.application.listen = originalListen;
    globalThis.setInterval = originalSetInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = nativeFetch;
    delete globalThis[stripeMock];
    hook.deregister();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
  }
}

test('default startup registers no commercial jobs and closed routes perform no external work', async () => {
  await withApp({}, async ({ request, networkCalls, stripeCalls, timers }) => {
    assert.equal((await request('/health')).body.ok, true);
    assert.equal((await request(`${basePath}/admin`)).status, 401);
    assert.equal((await request(`${basePath}/admin`, { headers: { Authorization: adminAuth } })).status, 200);
    const iframe = await request(`${basePath}/admin/webflow-studio`);
    assert.equal(iframe.status, 200);
    const policy = iframe.headers.get('content-security-policy');
    const nonce = policy.match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(nonce && iframe.body.includes(`<script nonce="${nonce}">`));
    assert.match(iframe.body, /llt-commercial-section/);
    assert.equal(policy.split(';').map(part => part.trim()).find(part => part.startsWith('frame-ancestors')),
      'frame-ancestors https://lltouch.com https://www.lltouch.com');
    assert.match(iframe.headers.get('cache-control'), /no-store/);
    assert.equal((await request(`${basePath}/mapped-availability`)).status, 403);
    assert.equal((await request(`${basePath}/mapped-reservation`, { body: {} })).status, 403);
    assert.equal((await request(`${basePath}/mapped-checkout`, { body: {} })).status, 403);
    assert.equal((await request(`${basePath}/leads`, { body: {} })).status, 403);
    assert.equal((await request(`${basePath}/admin/api/leads/ghl-dispatch-once/hydrafacial-local-qa`, {
      body: { intent: 'DISPATCH_ONE_CONTACT', campaignVersion: 2 }, headers: { Authorization: adminAuth }
    })).status, 403);
    assert.deepEqual(timers, []);
    assert.deepEqual(networkCalls, []);
    assert.deepEqual(stripeCalls, []);
  });
});

function crmWorkerFixture({ existing = false, revokeBeforeWrite = false, automatic = false,
  rateLimitedLookup = false, ambiguousTag = false, genericService = false, enrich = false } = {}) {
  const campaign = { ...campaignFixture(), status: 'published' };
  if (genericService) {
    campaign.service_title = 'Diamond Glow';
    Object.assign(campaign.marketing.campaignMeta.automationPlan, {
      serviceKey: 'diamond-glow', siteItem: { type: 'facial', service: 'diamond-glow', package: 'single', addon: 'none', quantity: 1 }
    });
  }
  const location = 'isolated-ghl-location';
  const crmOrigin = 'https://services.leadconnectorhq.com';
  const environment = {
    LLTOUCH_CM_COMMERCIAL_RELEASE_APPROVED: 'true',
    LLTOUCH_GHL_PRIVATE_TOKEN: 'synthetic-crm-token',
    LLTOUCH_GHL_LOCATION_ID: location,
    LLTOUCH_CM_GHL_VERIFIED_LOCATION_ID: location,
    LLTOUCH_CM_GHL_SYNC_ENABLED: 'true',
    LLTOUCH_CM_GHL_RELEASE_APPROVED: 'true',
    LLTOUCH_CM_GHL_03C11RE_EFFECTS_APPROVED: 'true',
    LLTOUCH_CM_GHL_AUTO_WORKFLOW_SAFETY_APPROVED: 'true',
    LLTOUCH_CM_GHL_EMERGENCY_STOP: 'false',
    ...(automatic ? {
      LLTOUCH_CM_GHL_AUTO_WORKER_ENABLED: 'true',
      LLTOUCH_CM_GHL_AUTO_RELEASE_APPROVED: 'true',
      LLTOUCH_CM_GHL_AUTO_MODE: 'pilot',
      LLTOUCH_CM_GHL_AUTO_PILOT_CAMPAIGN_KEY: campaign.campaign_key
    } : {
      LLTOUCH_CM_GHL_03C11L_PILOT_APPROVED: 'true',
      LLTOUCH_CM_GHL_TEST_CAMPAIGN_KEY: campaign.campaign_key
    })
  };
  const job = {
    lead_id: '77777777-7777-4777-8777-777777777777', lease_token: '88888888-8888-4888-8888-888888888888',
    campaign_key: campaign.campaign_key, campaign_version: campaign.version, customer_name: 'Synthetic da Silva',
    customer_email: 'crm-contact@example.invalid', customer_phone: '+12025550123', contact_consent: true,
    sms_marketing_consent: false, ghl_contact_id: null
  };
  const observed = { step: 'none', finished: false, effects: [], retries: [], active: true };
  const contact = {
    id: 'isolated-crm-contact', locationId: location, email: job.customer_email, phone: enrich ? null : job.customer_phone,
    name: 'Stored Name', firstName: 'Stored', lastName: 'Name', tags: existing || enrich ? ['lltouch-cm-lead'] : [],
    source: 'Older relationship', dnd: true, dndSettings: { SMS: { status: 'active' } }
  };
  async function advance(request, start) {
    const body = await request.json();
    assert.equal(body.p_lead_id, job.lead_id);
    assert.equal(body.p_lease_token, job.lease_token);
    assert.equal(body.p_expected_step, observed.step);
    if (start) {
      assert.equal(body.p_campaign_key, campaign.campaign_key);
      assert.equal(body.p_expected_version, campaign.version);
      if (revokeBeforeWrite) observed.active = false;
      if (!observed.active) return json(false);
    }
    observed.step = body.p_next_step;
    return json(true);
  }
  const mocks = {
    [`GET ${supabaseOrigin}/rest/v1/lltouch_campaigns`]: () => json([campaign]),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_lead_capture_settings`]: () => json([{
      campaign_key: campaign.campaign_key, campaign_version: campaign.version, enabled: true
    }]),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_lead_outbox`]: () => json([{
      external_step: observed.step, reconciliation_required: false
    }]),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_status_v1`]: () => json(commercialStatus(campaign, {
      version: campaign.version, revision: 1, active: observed.active, state: observed.active ? 'activated' : 'revoked'
    })),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_ghl_auto_candidates`]: () => json([{
      campaign_key: campaign.campaign_key, campaign_version: campaign.version
    }]),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_ghl_claim_one`]: () => json(observed.finished ? [] : [job]),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_ghl_begin_effect_v1`]: request => advance(request, true),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_ghl_effect_checkpoint`]: request => advance(request, false),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_ghl_record_contact`]: async request => {
      assert.equal((await request.json()).p_ghl_contact_id, contact.id);
      assert.equal(observed.step, 'upsert_started');
      observed.step = 'upsert_recorded';
      return json(true);
    },
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_ghl_finish`]: () => {
      assert.equal(observed.step, 'service_tag_recorded');
      observed.finished = true;
      return json(true);
    },
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_ghl_retry`]: async request => {
      observed.retries.push((await request.json()).p_reason);
      return json(true);
    },
    [`GET ${crmOrigin}/contacts/search/duplicate`]: (request, url) => {
      assert.equal(request.headers.get('version'), '2021-07-28');
      assert.equal(request.redirect, 'error');
      assert.equal(url.searchParams.get('locationId'), location);
      assert.ok(url.searchParams.get('email') === job.customer_email || url.searchParams.get('number') === job.customer_phone);
      if (rateLimitedLookup) {
        rateLimitedLookup = false;
        return json({ message: 'Synthetic rate limit' }, 429);
      }
      return json({ contact: existing || (enrich && url.searchParams.has('email')) ? contact : null });
    },
    [`POST ${crmOrigin}/contacts/upsert`]: async request => {
      assert.equal(observed.step, 'upsert_started');
      const submitted = await request.json();
      assert.deepEqual(submitted, {
        locationId: location, name: 'Synthetic da Silva', firstName: 'Synthetic', lastName: 'da Silva',
        email: job.customer_email, phone: job.customer_phone, source: 'LL Touch Campaign Studio'
      });
      Object.assign(contact, submitted);
      observed.effects.push('upsert');
      return json({ contact: { id: contact.id } });
    },
    [`GET ${crmOrigin}/contacts/${contact.id}`]: () => json({ contact }),
    [`PUT ${crmOrigin}/contacts/${contact.id}`]: async request => {
      assert.equal(observed.step, 'upsert_started');
      const patch = await request.json();
      assert.deepEqual(patch, { phone: job.customer_phone });
      Object.assign(contact, patch);
      observed.effects.push('update');
      return json({ contact: { id: contact.id } });
    },
    [`POST ${crmOrigin}/contacts/${contact.id}/tags`]: async request => {
      const { tags } = await request.json();
      assert.deepEqual(tags, [observed.step === 'lead_tag_started' ? 'lltouch-cm-lead' : 'lltouch-cm-hydrafacial']);
      observed.effects.push(...tags);
      contact.tags.push(...tags);
      if (ambiguousTag) return json({ message: 'Synthetic upstream error after accepting tag' }, 503);
      return json({ tags: contact.tags });
    }
  };
  const route = `${basePath}/admin/api/leads/ghl-dispatch-once/${campaign.campaign_key}`;
  const dispatch = { body: { intent: 'DISPATCH_ONE_CONTACT', campaignVersion: campaign.version }, headers: { Authorization: adminAuth } };
  return { environment, mocks, observed, route, dispatch, contact };
}

test('the CRM route links an existing contact, preserves DND, and skips already completed work', async () => {
  const fixture = crmWorkerFixture({ existing: true });
  await withApp(fixture, async ({ request, stripeCalls }) => {
    const first = await request(fixture.route, fixture.dispatch);
    assert.equal(first.status, 200);
    assert.equal(first.body.sent, 1);
    assert.equal(first.body.noSms, true);
    const repeat = await request(fixture.route, fixture.dispatch);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.claimed, 0);
    assert.deepEqual(fixture.observed.effects, ['lltouch-cm-hydrafacial']);
    assert.deepEqual(fixture.observed.retries, []);
    assert.equal(fixture.contact.dnd, true);
    assert.deepEqual(stripeCalls, []);
  });
});

test('the CRM route updates a verified contact by ID and preserves its identity, source and opt-out', async () => {
  const fixture = crmWorkerFixture({ enrich: true });
  await withApp(fixture, async ({ request }) => {
    const response = await request(fixture.route, fixture.dispatch);
    assert.equal(response.status, 200);
    assert.equal(response.body.sent, 1);
    assert.deepEqual(fixture.observed.effects, ['update', 'lltouch-cm-hydrafacial']);
    assert.equal(fixture.contact.phone, '+12025550123');
    assert.equal(fixture.contact.name, 'Stored Name');
    assert.equal(fixture.contact.source, 'Older relationship');
    assert.equal(fixture.contact.dnd, true);
    assert.deepEqual(fixture.contact.dndSettings, { SMS: { status: 'active' } });
  });
});

test('the automatic CRM worker upserts a new contact and applies tags without dispatching SMS', async () => {
  const fixture = crmWorkerFixture({ automatic: true });
  await withApp(fixture, async ({ timers, stripeCalls }) => {
    const worker = timers.find(item => item.kind === 'interval' && item.delay === 60_000);
    assert.ok(worker);
    worker.callback();
    for (let attempt = 0; attempt < 100 && !fixture.observed.finished; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(fixture.observed.finished, true);
    assert.deepEqual(fixture.observed.effects, ['upsert', 'lltouch-cm-lead', 'lltouch-cm-hydrafacial']);
    assert.deepEqual(fixture.observed.retries, []);
    assert.deepEqual(stripeCalls, []);
  });
});

test('the CRM route applies only the common tag for another mapped service', async () => {
  const fixture = crmWorkerFixture({ genericService: true });
  await withApp(fixture, async ({ request }) => {
    const response = await request(fixture.route, fixture.dispatch);
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.observed.effects, ['upsert', 'lltouch-cm-lead']);
    assert.equal(fixture.observed.finished, true);
  });
});

test('the CRM route refuses new external effects when the campaign is revoked before checkpointing', async () => {
  const fixture = crmWorkerFixture({ revokeBeforeWrite: true });
  await withApp(fixture, async ({ request, networkCalls }) => {
    const response = await request(fixture.route, fixture.dispatch);
    assert.equal(response.status, 503);
    assert.equal(response.body.errorCode, 'GHL_CAMPAIGN_BLOCKED');
    assert.deepEqual(fixture.observed.effects, []);
    assert.deepEqual(fixture.observed.retries, ['GHL_CAMPAIGN_BLOCKED']);
    assert.equal(fixture.observed.step, 'none');
    assert.equal(networkCalls.filter(call => call.url.host === 'services.leadconnectorhq.com' && call.method === 'POST').length, 0);
  });
});

test('the CRM route retries a read failure before any mutating checkpoint', async () => {
  const fixture = crmWorkerFixture({ rateLimitedLookup: true });
  await withApp(fixture, async ({ request }) => {
    const failed = await request(fixture.route, fixture.dispatch);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.errorCode, 'GHL_RATE_LIMIT');
    assert.equal(fixture.observed.step, 'none');
    assert.deepEqual(fixture.observed.effects, []);
    assert.deepEqual(fixture.observed.retries, ['GHL_RATE_LIMIT']);
    const retried = await request(fixture.route, fixture.dispatch);
    assert.equal(retried.status, 200);
    assert.deepEqual(fixture.observed.effects, ['upsert', 'lltouch-cm-lead', 'lltouch-cm-hydrafacial']);
  });
});

test('the CRM route blocks replay of a started effect without acknowledgment', async () => {
  const fixture = crmWorkerFixture({ ambiguousTag: true });
  await withApp(fixture, async ({ request }) => {
    const failed = await request(fixture.route, fixture.dispatch);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.errorCode, 'GHL_UNAVAILABLE');
    assert.equal(fixture.observed.step, 'lead_tag_started');
    assert.deepEqual(fixture.observed.effects, ['upsert', 'lltouch-cm-lead']);
    const retried = await request(fixture.route, fixture.dispatch);
    assert.equal(retried.status, 503);
    assert.equal(retried.body.errorCode, 'GHL_DB_ACK_FAILED');
    assert.equal(fixture.observed.step, 'lead_tag_started');
    assert.deepEqual(fixture.observed.effects, ['upsert', 'lltouch-cm-lead']);
  });
});

test('contract, Academy, original offer and legacy checkout HTTP routes remain isolated', async () => {
  const mocks = {
    [`GET ${supabaseOrigin}/rest/v1/academy_applications`]: () => json([])
  };
  await withApp({ mocks }, async ({ request, networkCalls, stripeCalls }) => {
    const contracts = await request('/llmk/contracts/readiness');
    assert.equal(contracts.status, 503);
    assert.equal(contracts.body.error, 'LLMK_BACKEND_CONFIGURATION_INCOMPLETE');

    const academy = await request('/academy/system-check');
    assert.equal(academy.status, 200);
    assert.equal(academy.body.checks.smsConfigured, false);
    assert.equal((await request('/academy/process-reminders', { body: {} })).status, 503);

    const originalOffer = await request('/lltouch/offer/config');
    assert.equal(originalOffer.status, 200);
    assert.equal(originalOffer.body.enabled, false);
    assert.equal(originalOffer.body.depositCents, 2500);
    assert.equal((await request('/create-checkout-session', { body: {} })).status, 400);
    assert.equal((await request('/llb/create-checkout-session', { body: {} })).status, 400);
    assert.equal((await request('/lltouch/campaign/nov09/confirm-batch', { body: {} })).body.code, 'CAMPAIGN_DISABLED');

    assert.deepEqual(networkCalls.map(call => call.url.pathname), ['/rest/v1/academy_applications']);
    assert.deepEqual(stripeCalls, []);
  });
});

function campaignFixture() {
  const now = Date.now();
  return {
    id: '11111111-1111-4111-8111-111111111111', campaign_key: 'hydrafacial-local-qa', version: 2,
    service_title: 'HydraFacial', status: 'draft', site_item: { type: 'manual', requiresVagaroMapping: true },
    currency: 'usd', regular_price_cents: 34900, price_cents: 14900, deposit_cents: 5000,
    hold_minutes: 10, timezone: 'America/New_York',
    offer_starts_at: new Date(now - 3_600_000).toISOString(), offer_ends_at: new Date(now + 86_400_000).toISOString(),
    marketing: {
      headline: 'Synthetic HydraFacial', description: 'Synthetic campaign used exclusively in isolated tests.',
      campaignMeta: {
        bookingMode: 'approval-required', releaseMode: 'display-only', bookingReady: false, checkoutReady: false,
        commercialManaged: true,
        automationPlan: {
          schemaVersion: 1, mappingStatus: 'local-catalog-match', serviceKey: 'hydrafacial', durationMinutes: 75,
          siteItem: { type: 'med-spa', service: 'hydrafacial', package: 'single', addon: 'none', quantity: 1 },
          providerKeys: ['ludimilla', 'carol'], priceCents: 14900, depositCents: 5000, balanceCents: 9900, holdMinutes: 10
        }
      }
    }
  };
}

function commercialStatus(campaign, authorization) {
  return { ok: true, campaignKey: campaign.campaign_key, status: campaign.status, version: campaign.version,
    managed: true, authorization, reviewToken: commercialReviewToken,
    scheduleState: campaign.status === 'published' ? 'active' : 'not-published' };
}

test('commercial admin uses actual authentication and blocks unconfigured or invalid approval', async () => {
  const campaign = campaignFixture();
  const authorization = { version: 2, revision: 0, active: false, state: 'none' };
  const assets = ['desktop', 'mobile'].map(device => ({
    asset_type: 'hero', device, position: 0, image_url: `https://synthetic-assets.invalid/${device}.jpg`
  }));
  const mocks = {
    [`GET ${supabaseOrigin}/rest/v1/lltouch_campaigns`]: (_request, url) =>
      json(url.searchParams.has('campaign_key') ? [campaign] : []),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_campaign_assets`]: () => json(assets),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_status_v1`]: () => json(commercialStatus(campaign, authorization)),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_dependencies_v1`]: () => json({ missing: [] }),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_metrics_v1`]: () => json({ leadsCaptured: 0, bookingsConfirmed: null })
  };
  const route = `${basePath}/admin/api/commercial/${campaign.campaign_key}`;
  const headers = { Authorization: adminAuth };
  const approval = {
    action: 'approve', expectedVersion: 2, expectedRevision: 0, confirmation: 'APROVAR',
    reviewToken: commercialReviewToken,
    review: { pricingVerified: true, clinicalCopyReviewed: true, imagesReviewed: true, publicVisibilityAccepted: true },
    availabilityDate: campaign.offer_ends_at.slice(0, 10)
  };
  await withApp({ mocks }, async ({ request, networkCalls, stripeCalls }) => {
    assert.equal((await request(route)).status, 401);
    assert.equal((await request(route, { headers, body: { ...approval, confirmation: 'INVALID' } })).status, 422);
    assert.equal((await request(route, { headers: { ...headers, Origin: 'https://lltouch.com' }, body: approval })).body.error,
      'CM_COMMERCIAL_ORIGIN_DENIED');
    assert.deepEqual(networkCalls, []);

    const readiness = await request(route, { headers });
    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.automaticSmsEnabled, false);
    assert.equal(readiness.body.plan.serviceKey, 'hydrafacial');
    assert.equal(readiness.body.plan.balanceCents, 9900);
    assert.equal(readiness.body.reviewToken, commercialReviewToken);
    assert.equal(readiness.body.ready, false);
    assert.equal(readiness.body.metrics.leadsCaptured, 0);
    assert.equal(readiness.body.metrics.bookingsConfirmed, null);
    assert.ok(readiness.body.blockers.some(item => item.code === 'CM_MAPPED_STRIPE_NOT_CONFIGURED'));
    assert.ok(!readiness.body.blockers.some(item => item.code === 'CM_COMMERCIAL_TERMS_OR_ASSETS'));

    const blocked = await request(route, { headers, body: approval });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'CM_COMMERCIAL_NOT_READY');
    const beforeStale = networkCalls.length;
    const staleReview = await request(route, { headers, body: { ...approval, reviewToken: 'b'.repeat(64) } });
    assert.equal(staleReview.status, 409);
    assert.equal(staleReview.body.error, 'CM_COMMERCIAL_REVIEW_STALE');
    assert.ok(networkCalls.slice(beforeStale).every(call => call.url.origin === supabaseOrigin));
    for (const [field, code] of [['expectedVersion', 'VERSION'], ['expectedRevision', 'REVISION']]) {
      const stale = await request(route, { headers, body: { ...approval, [field]: 3 } });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error, `CM_COMMERCIAL_${code}_CONFLICT`);
    }

    campaign.deposit_cents = 15000;
    const invalidPrice = await request(route, { headers });
    assert.equal(invalidPrice.body.plan, null);
    assert.ok(invalidPrice.body.blockers.some(item => item.code === 'CM_COMMERCIAL_TERMS_OR_ASSETS'));
    assert.ok(invalidPrice.body.blockers.some(item => item.code === 'CM_COMMERCIAL_PLAN_INVALID'));
    assert.deepEqual(stripeCalls, []);
  });
});

test('commercial campaigns reject legacy publication and lead settings while display-only campaigns keep those controls', async () => {
  const campaign = { ...campaignFixture(), status: 'published', deposit_cents: 2500 };
  const key = campaign.campaign_key;
  const headers = { Authorization: adminAuth };
  const assets = ['desktop', 'mobile'].map(device => ({
    asset_type: 'hero', device, position: 0, image_url: `https://synthetic-assets.invalid/${device}.jpg`
  }));
  const legacyWrites = [];
  const mocks = {
    [`GET ${supabaseOrigin}/rest/v1/lltouch_campaigns`]: (_request, url) => json(url.searchParams.has('campaign_key') ? [campaign] : []),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_campaign_assets`]: () => json(assets),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_lead_capture_configure`]: async request => {
      legacyWrites.push(await request.json());
      return json({ enabled: false });
    },
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_display_release`]: async request => {
      legacyWrites.push(await request.json());
      return json([{ campaign_key: key, new_version: 3, new_status: 'paused' }]);
    }
  };
  await withApp({ environment: { LLTOUCH_CM_LEAD_CONFIG_ADMIN_ENABLED: 'true' }, mocks }, async ({ request }) => {
    const display = `${basePath}/admin/api/display`;
    const configure = `${basePath}/admin/api/leads/configure/${key}`;
    const pause = { campaignKey: key, expectedVersion: 2, action: 'pause', confirmation: 'PAUSAR' };
    const settings = { expectedVersion: 2, enabled: false };
    const managed = await request(`${display}/check/${key}`, { headers });
    assert.equal(managed.body.commercialManaged, true);
    assert.equal(managed.body.visualOnly, false);
    assert.equal((await request(`${display}/release`, { headers, body: pause })).status, 409);
    assert.equal((await request(configure, { headers, body: settings })).status, 409);
    assert.deepEqual(legacyWrites, []);

    delete campaign.marketing.campaignMeta.commercialManaged;
    const unmanaged = await request(`${display}/check/${key}`, { headers });
    assert.equal(unmanaged.body.visualOnly, true);
    assert.equal((await request(configure, { headers, body: settings })).status, 200);
    assert.equal((await request(`${display}/release`, { headers, body: pause })).status, 200);
    assert.deepEqual(legacyWrites, [
      { p_campaign_key: key, p_expected_version: 2, p_enabled: false },
      { p_campaign_key: key, p_expected_version: 2, p_action: 'pause' }
    ]);
  });
});

test('managed lead intake checks version, authorizes active campaigns and preserves optional SMS consent without dispatch', async () => {
  const campaign = { ...campaignFixture(), status: 'published' };
  const authorization = { version: 2, revision: 2, active: true, state: 'activated' };
  const leadId = '22222222-2222-4222-8222-222222222222';
  const nonce = '33333333-3333-4333-8333-333333333333';
  const submits = [];
  const mocks = {
    [`GET ${supabaseOrigin}/rest/v1/lltouch_campaigns`]: () => json([campaign]),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_lead_capture_settings`]: () => json([{ enabled: true, campaign_version: 2 }]),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_status_v1`]: () => json(commercialStatus(campaign, authorization)),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_submit_v1`]: async request => {
      submits.push(await request.json());
      return json({ ok: true, leadId, idempotent: submits.length > 1, contactOnly: true, bookingReady: false, checkoutReady: false });
    }
  };
  const environment = {
    LLTOUCH_CM_COMMERCIAL_RELEASE_APPROVED: 'true',
    LLTOUCH_CM_03C11E_RELEASE_ENABLED: 'true',
    LLTOUCH_CM_PUBLIC_LEADS_ENABLED: 'true'
  };
  const lead = { campaignKey: campaign.campaign_key, campaignVersion: 2, name: 'Synthetic QA',
    email: 'contact@campaign-qa.invalid', phone: '+17815550101', consent: true, client_nonce: nonce, sms_marketing_consent: false };
  const headers = { Origin: 'https://lltouch.com' };

  await withApp({ environment, mocks }, async ({ request, networkCalls, stripeCalls }) => {
    const first = await request(`${basePath}/leads`, { headers, body: lead });
    assert.equal(first.status, 201);
    assert.equal(first.body.lead_id, leadId);
    assert.equal(first.body.ghlDispatched, false);
    assert.equal(first.body.bookingReady, false);
    const retry = await request(`${basePath}/leads`, { headers, body: lead });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent, true);

    authorization.active = false;
    const revoked = await request(`${basePath}/leads`, { headers, body: lead });
    assert.equal(revoked.status, 409);
    assert.equal(revoked.body.error, 'LEAD_CAPTURE_UNAVAILABLE');
    assert.equal(submits.length, 2);
    assert.deepEqual(submits[0], submits[1]);
    assert.equal(submits[0].p_client_nonce, nonce);
    assert.equal(submits[0].p_contact_consent, true);
    assert.equal(submits[0].p_sms_marketing_consent, false);
    assert.ok(networkCalls.every(call => call.url.origin === supabaseOrigin));
    assert.deepEqual(stripeCalls, []);
  });
});

test('the worker defers an unreadable Stripe session and verifies closure before releasing the next hold', async () => {
  const hold = { id: '44444444-4444-4444-8444-444444444444', campaign_id: '11111111-1111-4111-8111-111111111111',
    campaign_key: 'hydrafacial-local-qa', campaign_version: 2, stripe_session_id: 'cs_live_synthetic_due_only',
    state: 'checkout', expires_at: new Date(Date.now()-1000).toISOString(),
    quote_snapshot: { mode: 'mapped-service-v1', campaignKey: 'hydrafacial-local-qa', campaignVersion: 2,
      currency: 'usd', priceCents: 14900, depositCents: 2500, balanceCents: 12400 } };
  const snapshot = { id: '55555555-5555-4555-8555-555555555555', hold_id: hold.id, campaign_id: hold.campaign_id,
    campaign_key: hold.campaign_key, campaign_version: 2, currency: 'usd', price_cents: 14900, deposit_cents: 2500,
    immutable_terms: hold.quote_snapshot };
  const nextHold = { ...hold, id: '66666666-6666-4666-8666-666666666666', stripe_session_id: 'cs_live_second_synthetic_due' };
  const nextSnapshot = { ...snapshot, id: '77777777-7777-4777-8777-777777777777', hold_id: nextHold.id };
  let stripeClosed = false;
  const results = [];
  let deferred;
  const recorded = new Promise(resolve => { deferred = resolve; });
  const mocks = {
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_mapped_due_issues_v1`]: () =>
      json([[hold, snapshot], [nextHold, nextSnapshot]].map(([hold, snapshot]) =>
        ({ snapshot_id: snapshot.id, hold_id: hold.id, session_id: hold.stripe_session_id }))),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_universal_holds`]: (_request, url) =>
      json([url.searchParams.get('id')===`eq.${hold.id}` ? hold : nextHold]),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_universal_checkout_snapshots`]: (_request, url) =>
      json([url.searchParams.get('id')===`eq.${snapshot.id}` ? snapshot : nextSnapshot]),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_mapped_poll_result_v1`]: async request => {
      results.push(await request.json());
      if(results.length===2)deferred(results);
      return json({ ok: true });
    }
  };
  const environment = { LLTOUCH_CM_MAPPED_EXPIRY_WORKER_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_synthetic_local_only',
    STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_local_only' };
  const stripe = {
    'checkout.sessions.retrieve': id => {
      if(id===hold.stripe_session_id)throw Error('Synthetic Stripe timeout');
      assert.equal(id,nextHold.stripe_session_id);
      return { id, livemode: true, object: 'checkout.session', mode: 'payment', currency: 'usd', amount_total: 2500,
        metadata: { cm_scope: 'lltouch-cm-mapped-v1', hold_id: nextHold.id, snapshot_id: nextSnapshot.id,
          campaign_key: nextHold.campaign_key, campaign_version: '2' },
        status: stripeClosed?'expired':'open', payment_status: 'unpaid', payment_intent: null };
    },
    'checkout.sessions.expire': id => { assert.equal(id,nextHold.stripe_session_id);stripeClosed=true; }
  };
  await withApp({ mocks, environment, stripe }, async ({ timers, stripeCalls }) => {
    const worker = timers.find(timer => timer.kind === 'interval' && timer.delay === 15000);
    assert.ok(worker);
    worker.callback();
    assert.deepEqual(await Promise.race([recorded,
      new Promise((_, reject) => setTimeout(() => reject(Error('Reconciliation did not finish')), 1000).unref())]), [
      { p_snapshot: snapshot.id, p_hold: hold.id, p_session: hold.stripe_session_id, p_action: 'wait',
        p_reason: 'RECONCILIATION_READ_UNAVAILABLE', p_paid_at: null },
      { p_snapshot: nextSnapshot.id, p_hold: nextHold.id, p_session: nextHold.stripe_session_id, p_action: 'expiry_candidate',
        p_reason: 'STRIPE_CLOSED_UNPAID', p_paid_at: null }
    ]);
    assert.deepEqual(stripeCalls.map(call => call.operation), ['checkout.sessions.retrieve', 'checkout.sessions.retrieve',
      'checkout.sessions.expire', 'checkout.sessions.retrieve']);
  });
});

test('approved mapped HTTP flow verifies slots, reuses checkout and reviews a signed wrong-amount payment', async () => {
  const campaign = { ...campaignFixture(), version: 1 };
  const authorization = { version: null, revision: 0, active: false, state: 'unapproved' };
  const date = new Date(Date.now() + 2 * 86_400_000);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  const day = date.toISOString().slice(0, 10);
  const campaignKey = campaign.campaign_key;
  const clientNonce = '33333333-3333-4333-8333-333333333333';
  const leadId = '22222222-2222-4222-8222-222222222222';
  const holdId = '44444444-4444-4444-8444-444444444444';
  const snapshotId = '55555555-5555-4555-8555-555555555555';
  const sessionId = 'cs_live_synthetic_local_qa_1';
  const vagaroServiceId = 'RCAVN7dx4ToC1Rz0jWS0tA==';
  const webhookSecret = 'whsec_synthetic_local_only';
  const stripeWebhooks = new Stripe('sk_test_synthetic_local_only').webhooks;
  const vagaroOrigin = 'https://api.vagaro.com/us03/api/v2';
  const googleOrigin = 'https://www.googleapis.com/calendar/v3';
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const environment = {
    ...crmWorkerFixture({ automatic: true }).environment,
    LLTOUCH_CM_COMMERCIAL_RELEASE_APPROVED: 'true', LLTOUCH_CM_03C11E_RELEASE_ENABLED: 'true',
    LLTOUCH_CM_PUBLIC_LEADS_ENABLED: 'true', LLTOUCH_CROSS_SERVICE_CONSTRAINT_READY: 'true',
    LLTOUCH_CM_MAPPED_RESERVATION_ENABLED: 'true', LLTOUCH_CM_MAPPED_CHECKOUT_ENABLED: 'true',
    LLTOUCH_CM_MAPPED_EXPIRY_WORKER_ENABLED: 'true', LLTOUCH_CM_MAPPED_BOOKING_ENABLED: 'true',
    LLTOUCH_CM_MAPPED_BOOKING_HOMOLOGATED: 'true', STRIPE_SECRET_KEY: 'sk_live_synthetic_local_only',
    STRIPE_WEBHOOK_SECRET: webhookSecret, VAGARO_CLIENT_ID: 'synthetic', VAGARO_CLIENT_SECRET: 'synthetic',
    VAGARO_LUDIMILLA_PROVIDER_ID: 'synthetic-ludimilla', VAGARO_CAROL_PROVIDER_ID: 'synthetic-carol',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@calendar.invalid', GOOGLE_PRIVATE_KEY: privateKey,
    GOOGLE_CALENDAR_ID: 'synthetic-ludimilla-cal', GOOGLE_CALENDAR_CAROL_ID: 'synthetic-carol-cal'
  };
  let hold, snapshot, session;
  let review = null;
  let busyAtCheckout = false;
  let revokeAfterIssueClaim = false;
  let retrievedSessionId = sessionId;
  let issueBegins = 0;
  const mocks = {
    [`GET ${supabaseOrigin}/rest/v1/lltouch_campaigns`]: (_request, url) =>
      json(url.searchParams.has('campaign_key') ? [campaign] : []),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_campaign_assets`]: () => json(['desktop', 'mobile'].map(device => ({
      asset_type: 'hero', device, position: 0, image_url: `https://synthetic-assets.invalid/${device}.jpg`
    }))),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_lead_capture_settings`]: () => json([{ enabled: true, campaign_version: 2 }]),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_status_v1`]: () =>
      json({ ...commercialStatus(campaign, authorization), managed: authorization.revision > 0 }),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_dependencies_v1`]: () => json({ missing: [] }),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_commercial_lifecycle_v1`]: async request => {
      const args = await request.json();
      assert.equal(args.p_actor, adminUser);
      assert.equal(args.p_expected_revision, authorization.revision);
      assert.equal(args.p_expected_version, campaign.version);
      if (args.p_action === 'approve') {
        assert.equal(args.p_review.reviewToken, commercialReviewToken);
        assert.deepEqual(args.p_review.availability.providers, ['ludimilla', 'carol']);
        assert.deepEqual(args.p_review.availability.sources, ['Vagaro', 'Google Calendar', 'Supabase']);
        assert.equal(args.p_review.availability.slots, 2);
        Object.assign(authorization, { version: 1, revision: 1, state: 'approved' });
      } else if (args.p_action === 'publish') {
        Object.assign(campaign, { version: 2, status: 'published' });
        Object.assign(authorization, { version: 2, revision: 2, active: true, state: 'activated' });
        Object.assign(campaign.marketing.campaignMeta, { mappedReservationAuthorized: true, mappedCheckoutAuthorized: true });
      } else {
        assert.equal(args.p_action, 'pause');
        Object.assign(campaign, { version: 3, status: 'paused' });
        Object.assign(authorization, { version: 3, revision: 3, active: false, state: 'revoked' });
      }
      return json(commercialStatus(campaign, authorization));
    },
    [`POST ${vagaroOrigin}/merchants/generate-access-token`]: () => json({ status: 200, data: { access_token: 'synthetic' } }),
    [`POST ${vagaroOrigin}/services`]: () => json({ data: { services: [{ serviceId: vagaroServiceId, serviceTitle: 'HydraFacial',
      servicePerformedBy: ['synthetic-ludimilla', 'synthetic-carol'].map(serviceProviderId => ({ serviceProviderId, durationMinutes: 75 })) }] } }),
    [`POST ${vagaroOrigin}/appointments/availability`]: () => json({ data: [{ appointmentDate: day, timeSlot: ['10:00', '10:00', '18:00'] }] }),
    'POST https://oauth2.googleapis.com/token': () => json({ access_token: 'synthetic', expires_in: 3600 }),
    [`GET ${googleOrigin}/calendars/synthetic-ludimilla-cal/events`]: () => json({ items: busyAtCheckout ? [{
      id: 'synthetic-conflict', status: 'confirmed', start: { dateTime: hold.appointment_start }, end: { dateTime: hold.appointment_end }
    }] : [] }),
    [`GET ${googleOrigin}/calendars/synthetic-carol-cal/events`]: () => json({ items: [] }),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_universal_holds`]: (_request, url) =>
      json(hold && (url.searchParams.get('id') === `eq.${holdId}` || url.searchParams.has('client_nonce')) ? [hold] : []),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_universal_checkout_snapshots`]: () => json([snapshot]),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_mapped_issue_v1`]: () => json([{ state: 'review', session_id: sessionId }]),
    [`GET ${supabaseOrigin}/rest/v1/lltouch_cm_mapped_booking_v1`]: () => json([]),
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_mapped_reserve_v1`]: async request => {
      const args = await request.json();
      assert.equal(args.p_service_id, vagaroServiceId);
      assert.equal(args.p_provider_id, 'synthetic-ludimilla');
      assert.equal(args.p_lead_id, leadId);
      const idempotent = !!hold;
      if (!hold) {
        const created = Date.now();
        const start = args.p_start;
        const end = new Date(Date.parse(start) + 75 * 60_000).toISOString();
        const quote = { mode: 'mapped-service-v1', campaignKey, campaignVersion: 2, serviceName: 'HydraFacial',
          serviceId: vagaroServiceId, providerKey: 'ludimilla', providerId: 'synthetic-ludimilla', leadId, currency: 'usd', durationMinutes: 75,
          priceCents: 14900, depositCents: 5000, balanceCents: 9900, holdMinutes: 10, appointmentStart: start, appointmentEnd: end };
        hold = { id: holdId, state: 'held', campaign_id: campaign.id, campaign_key: campaignKey, campaign_version: 2,
          client_nonce: clientNonce, provider_key: 'ludimilla', stripe_session_id: null, requested_date: day, requested_time: '10:00:00',
          appointment_start: start, appointment_end: end,
          customer_email: 'contact@campaign-qa.invalid', quote_snapshot: quote, created_at: new Date(created).toISOString(),
          expires_at: new Date(created + 600_000).toISOString() };
        snapshot = { id: snapshotId, hold_id: holdId, campaign_id: campaign.id, campaign_key: campaignKey, campaign_version: 2,
          currency: 'usd', sessions: 1, price_cents: 14900, deposit_cents: 5000, immutable_terms: quote };
      }
      return json({ ok: true, holdId, snapshotId, expiresAt: hold.expires_at, idempotent, checkoutReady: false });
    },
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_mapped_issue_begin_v1`]: () => {
      issueBegins++;
      hold.state = 'checkout';
      if (revokeAfterIssueClaim) authorization.active = false;
      return json({ ok: true, state: hold.stripe_session_id ? 'bound' : 'issuing', sessionId: hold.stripe_session_id, hold, snapshot });
    },
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_mapped_issue_bind_v1`]: async request => {
      const args = await request.json();
      assert.equal(args.p_session, sessionId);
      hold.stripe_session_id = args.p_session;
      return json({ ok: true });
    },
    [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_mapped_issue_event_v1`]: async request => {
      review = await request.json();
      hold.state = 'review';
      return json({ ok: true });
    }
  };
  for (const table of ['lltouch_appointments', 'lltouch_offer_claims', 'lltouch_pwyc_checkout_holds', 'academy_bookings']) {
    mocks[`GET ${supabaseOrigin}/rest/v1/${table}`] = () => json([]);
  }
  const stripe = {
    'checkout.sessions.create': (params, options) => {
      assert.equal(params.line_items[0].price_data.unit_amount, 5000);
      assert.equal(options.idempotencyKey, `llt-cm-mapped-${snapshotId}`);
      session = { object: 'checkout.session', id: sessionId, livemode: true, amount_total: 5000, currency: 'usd', mode: 'payment',
        status: 'open', payment_status: 'unpaid', payment_intent: null, expires_at: params.expires_at,
        metadata: params.metadata, url: `https://checkout.stripe.com/c/pay/${sessionId}` };
      return session;
    },
    'checkout.sessions.retrieve': id => {
      assert.equal(id, sessionId);
      return { ...session, id: retrievedSessionId };
    },
    'webhooks.constructEvent': (...args) => stripeWebhooks.constructEvent(...args)
  };
  const headers = { Origin: 'https://lltouch.com' };
  const identity = { campaignKey, campaignVersion: 2, clientNonce, leadId };
  const selection = { ...identity, providerKey: 'ludimilla', date: day, time: '10:00' };

  await withApp({ environment, mocks, stripe }, async ({ request, networkCalls, stripeCalls }) => {
    const adminRoute = `${basePath}/admin/api/commercial/${campaignKey}`;
    const adminHeaders = { Authorization: adminAuth };
    const approved = await request(adminRoute, { headers: adminHeaders, body: {
      action: 'approve', expectedVersion: 1, expectedRevision: 0, confirmation: 'APROVAR', availabilityDate: day, reviewToken: commercialReviewToken,
      review: { pricingVerified: true, clinicalCopyReviewed: true, imagesReviewed: true, publicVisibilityAccepted: true }
    } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.authorization.state, 'approved');
    const published = await request(adminRoute, { headers: adminHeaders, body: {
      action: 'publish', expectedVersion: 1, expectedRevision: 1, confirmation: 'PUBLICAR'
    } });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.authorization.active, true);

    const query = new URLSearchParams({ campaignKey, campaignVersion: '2', providerKey: 'ludimilla', date: day });
    const availability = await request(`${basePath}/mapped-availability?${query}`, { headers });
    assert.equal(availability.status, 200, JSON.stringify(availability.body));
    assert.deepEqual(availability.body.slots, ['10:00']);
    assert.equal(availability.body.noHold, true);
    assert.equal(availability.body.noPayment, true);
    assert.ok(networkCalls.some(call => call.url.pathname === '/rest/v1/academy_bookings'));

    assert.equal((await request(`${basePath}/mapped-reservation`, { headers, body: { ...selection, priceCents: 1 } })).status, 409);
    const reservation = await request(`${basePath}/mapped-reservation`, { headers, body: selection });
    assert.equal(reservation.status, 201, JSON.stringify(reservation.body));
    assert.equal(reservation.body.holdId, holdId);
    assert.equal(reservation.body.bookingReady, false);
    assert.equal((await request(`${basePath}/mapped-reservation`, { headers, body: selection })).body.idempotent, true);

    const checkout = { ...identity, holdId, snapshotId };
    busyAtCheckout = true;
    const conflict = await request(`${basePath}/mapped-checkout`, { headers, body: checkout });
    assert.equal(conflict.body.error, 'CM_MAPPED_SLOT_UNAVAILABLE');
    assert.equal(issueBegins, 0);
    assert.deepEqual(stripeCalls, []);
    busyAtCheckout = false;

    revokeAfterIssueClaim = true;
    const revoked = await request(`${basePath}/mapped-checkout`, { headers, body: checkout });
    assert.equal(revoked.body.error, 'CM_MAPPED_CHECKOUT_NOT_OPEN');
    assert.deepEqual(stripeCalls, []);
    revokeAfterIssueClaim = false;
    // Reset the synthetic scenario to a newly valid issuance without releasing the proof.
    authorization.active = true;
    hold.state = 'held';

    const opened = await request(`${basePath}/mapped-checkout`, { headers, body: checkout });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.sessionId, sessionId);
    retrievedSessionId = 'cs_live_unrelated_synthetic_1';
    const wrongSession = await request(`${basePath}/mapped-checkout`, { headers, body: checkout });
    assert.equal(wrongSession.body.error, 'CM_MAPPED_BIND_CONFLICT');
    assert.equal(wrongSession.body.url, undefined);
    retrievedSessionId = sessionId;
    assert.equal((await request(`${basePath}/mapped-checkout`, { headers, body: checkout })).body.url, opened.body.url);
    assert.equal(stripeCalls.filter(call => call.operation === 'checkout.sessions.create').length, 1);

    session = { ...session, amount_total: 4900, status: 'complete', payment_status: 'paid' };
    const body = { id: 'evt_synthetic_wrong_amount_1', type: 'checkout.session.completed', livemode: true, data: { object: session } };
    const signature = stripeWebhooks.generateTestHeaderString({ payload: JSON.stringify(body), secret: webhookSecret });
    assert.equal((await request('/webhook', { headers: { 'stripe-signature': signature }, body })).status, 200);
    assert.equal(review.p_action, 'review');
    assert.equal(review.p_reason, 'SESSION_OR_TERMS_MISMATCH');
    assert.equal(review.p_paid_at, null);

    const receipt = await request(`${basePath}/mapped-receipt`, { headers, body: { ...checkout, sessionId } });
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.appointmentConfirmed, false);
    assert.equal(receipt.body.paid, false);
    assert.equal(receipt.body.status, 'review');
    snapshot.immutable_terms = { ...snapshot.immutable_terms, priceCents: 14901 };
    const mismatchedReceipt = await request(`${basePath}/mapped-receipt`, { headers, body: { ...checkout, sessionId } });
    assert.equal(mismatchedReceipt.status, 409);
    assert.equal(mismatchedReceipt.body.error, 'CM_MAPPED_RECEIPT_UNVERIFIED');
    assert.ok(!networkCalls.some(call => /twilio|leadconnector|highlevel/.test(call.url.hostname)));

    const paused = await request(adminRoute, { headers: adminHeaders, body: {
      action: 'pause', expectedVersion: 2, expectedRevision: 2, confirmation: 'PAUSAR'
    } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, 'paused');
    assert.equal((await request(`${basePath}/mapped-availability?${query}`, { headers })).status, 409);
  });
});

test('mapped booking worker retains a shared pending slot on an uncertain calendar write and verifies an exact recovered event', async () => {
  for (const recoverable of [false, true]) {
    const sessionId = 'cs_live_synthetic_booking_1';
    const intentId = 'pi_syntheticBooking';
    const holdId = '44444444-4444-4444-8444-444444444444';
    const snapshotId = '55555555-5555-4555-8555-555555555555';
    const bookingId = '99999999-9999-4999-8999-999999999999';
    const campaignKey = 'hydrafacial-local-qa';
    const providerId = 'synthetic-ludimilla';
    const serviceId = 'RCAVN7dx4ToC1Rz0jWS0tA==';
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const noon = new Date(day + 'T12:00:00Z');
    const easternHour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23'
    }).format(noon));
    const start = noon.getTime() + (10 - easternHour) * 3_600_000;
    const startsAt = new Date(start).toISOString();
    const endsAt = new Date(start + 75 * 60_000).toISOString();
    const terms = {
      mode: 'mapped-service-v1', campaignKey, campaignVersion: 2, serviceKey: 'hydrafacial',
      siteItem: { type: 'med-spa', service: 'hydrafacial', package: 'single', addon: 'none', quantity: 1 },
      serviceId, providerKey: 'ludimilla', providerId, durationMinutes: 75, currency: 'usd',
      priceCents: 14900, depositCents: 2500, balanceCents: 12400, appointmentStart: startsAt, appointmentEnd: endsAt
    };
    const now = Date.now();
    const hold = {
      id: holdId, state: 'processing', campaign_id: 'synthetic-campaign', campaign_key: campaignKey,
      campaign_version: 2, stripe_session_id: sessionId, provider_key: 'ludimilla', quote_snapshot: terms,
      requested_date: day, requested_time: '10:00:00', appointment_start: startsAt, appointment_end: endsAt,
      created_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 540_000).toISOString(),
      customer_name: 'Synthetic Recipient', customer_email: 'booking@campaign-qa.invalid', customer_phone: '+17815550101'
    };
    const snapshot = {
      id: snapshotId, hold_id: holdId, campaign_id: hold.campaign_id, campaign_key: campaignKey,
      campaign_version: 2, currency: 'usd', price_cents: 14900, deposit_cents: 2500, immutable_terms: terms
    };
    const metadata = {
      cm_scope: 'lltouch-cm-mapped-v1', hold_id: holdId, snapshot_id: snapshotId, campaign_key: campaignKey, campaign_version: '2'
    };
    const stripe = {
      'checkout.sessions.retrieve': id => {
        assert.equal(id, sessionId);
        return { id, object: 'checkout.session', status: 'complete', mode: 'payment', livemode: true,
          payment_status: 'paid', currency: 'usd', amount_total: 2500, payment_intent: intentId, metadata };
      },
      'paymentIntents.retrieve': id => {
        assert.equal(id, intentId);
        return { id, object: 'payment_intent', status: 'succeeded', capture_method: 'automatic',
          currency: 'usd', amount: 2500, amount_received: 2500, livemode: true, metadata,
          latest_charge: { object: 'charge', id: 'ch_syntheticBooking', payment_intent: id, status: 'succeeded',
            paid: true, captured: true, refunded: false, disputed: false, livemode: true,
            currency: 'usd', amount: 2500, amount_captured: 2500, amount_refunded: 0, created: Math.floor(now / 1000) } };
      }
    };
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const environment = {
      STRIPE_SECRET_KEY: 'sk_live_synthetic_local_only', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_local_only',
      LLTOUCH_CROSS_SERVICE_CONSTRAINT_READY: 'true', LLTOUCH_CM_MAPPED_BOOKING_ENABLED: 'true',
      LLTOUCH_CM_MAPPED_BOOKING_HOMOLOGATED: 'true', VAGARO_CLIENT_ID: 'synthetic', VAGARO_CLIENT_SECRET: 'synthetic',
      VAGARO_LUDIMILLA_PROVIDER_ID: providerId, VAGARO_CAROL_PROVIDER_ID: 'synthetic-carol',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@calendar.invalid', GOOGLE_PRIVATE_KEY: privateKey,
      GOOGLE_CALENDAR_ID: 'synthetic-ludimilla-cal', GOOGLE_CALENDAR_CAROL_ID: 'synthetic-carol-cal'
    };
    const googleEvents = 'https://www.googleapis.com/calendar/v3/calendars/synthetic-ludimilla-cal/events';
    const vagaro = 'https://api.vagaro.com/us03/api/v2';
    const appointments = supabaseOrigin + '/rest/v1/lltouch_appointments';
    let pending;
    let remoteEvent;
    const writes = [];
    const finished = Promise.withResolvers();
    const mocks = {
      [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_mapped_booking_claim_v1`]: () => json({ ok: true, claimed: true, hold, snapshot }),
      [`POST ${supabaseOrigin}/rest/v1/rpc/lltouch_cm_mapped_booking_finish_v1`]: async request => {
        finished.resolve(await request.json());
        return json({ ok: true });
      },
      [`POST ${vagaro}/merchants/generate-access-token`]: () => json({ status: 200, data: { access_token: 'synthetic' } }),
      [`POST ${vagaro}/services`]: () => json({ data: { services: [{ serviceId, serviceTitle: 'HydraFacial',
        servicePerformedBy: [{ serviceProviderId: providerId, durationMinutes: 75 }] }] } }),
      [`POST ${vagaro}/appointments/availability`]: () => json({ data: [{ appointmentDate: day, timeSlot: ['10:00'] }] }),
      'POST https://oauth2.googleapis.com/token': () => json({ access_token: 'synthetic', expires_in: 3600 }),
      [`GET ${googleEvents}`]: () => json({ items: [] }),
      [`POST ${googleEvents}`]: async request => {
        remoteEvent = await request.json();
        remoteEvent.start.dateTime = startsAt;
        remoteEvent.end.dateTime = endsAt;
        return json({ error: { message: 'Synthetic ambiguous write' } }, 503);
      },
      [`GET ${appointments}`]: (_request, url) => json(url.searchParams.has('id') ? [pending] : []),
      [`POST ${appointments}`]: async request => {
        const body = await request.json();
        assert.equal(body.status, 'pending');
        pending = { ...body, id: bookingId };
        mocks[`GET ${googleEvents}/${body.google_event_id}`] = () => recoverable
          ? json(remoteEvent)
          : json({ ...remoteEvent, extendedProperties: { private: { llTouchBookingId: bookingId } } });
        return json(pending);
      },
      [`PATCH ${appointments}`]: async request => {
        const changes = await request.json();
        writes.push(changes.status);
        pending = { ...pending, ...changes };
        return json(pending);
      }
    };
    for (const table of ['lltouch_offer_claims', 'lltouch_pwyc_checkout_holds', 'academy_bookings']) {
      mocks[`GET ${supabaseOrigin}/rest/v1/${table}`] = () => json([]);
    }
    await withApp({ environment, mocks, stripe }, async ({ timers, stripeCalls }) => {
      assert.equal(timers.length, 1);
      timers[0].callback();
      let deadline;
      try {
        const result = await Promise.race([finished.promise, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(Error('Booking worker did not complete')), 5000);
        })]);
        assert.ok(pending);
        assert.equal(result.p_outcome, recoverable ? 'calendar_verified' : 'review');
        assert.equal(result.p_booking, recoverable ? bookingId : null);
        assert.equal(pending.status, recoverable ? 'confirmed' : 'pending');
        assert.deepEqual(writes, recoverable ? ['confirmed'] : []);
        assert.ok(stripeCalls.every(call => ['checkout.sessions.retrieve', 'paymentIntents.retrieve'].includes(call.operation)));
      } finally {
        clearTimeout(deadline);
      }
    });
  }
});
