import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCampaignCrmContactTag, campaignCrmContactHasTag, campaignCrmContactUpdate, campaignCrmRequest,
  campaignCrmWorkflowSafetyApproved, findCampaignCrmContact, writeCampaignCrmContact
} from '../../lltouch-cm-ghl-contact-v1.mjs';

const payload = Object.freeze({
  locationId: 'synthetic-location',
  name: 'Mariana da Silva',
  firstName: 'Mariana',
  lastName: 'da Silva',
  email: 'mariana@example.invalid',
  phone: '+17815550100',
  source: 'LL Touch Campaign Studio'
});
const contact = Object.freeze({
  id: 'existing-contact',
  locationId: payload.locationId,
  email: payload.email.toUpperCase(),
  phone: '+1 (781) 555-0100',
  name: 'Mariana Silva',
  firstName: 'Mariana',
  lastName: 'Silva',
  source: 'Existing intake',
  tags: ['lltouch-cm-lead'],
  dnd: true,
  dndSettings: { SMS: { status: 'active' } },
  sms_marketing_consent: false
});
const normalizePhone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  return digits.length === 11 ? '+' + digits : '';
};

function duplicateSearch(byEmail, byPhone, fresh = byEmail?.contact || byPhone?.contact) {
  return async (path, method) => {
    assert.equal(method, 'GET');
    const request = new URL(path, 'https://crm.example.invalid');
    if (fresh && request.pathname === '/contacts/' + fresh.id) return { contact: fresh };
    assert.equal(request.pathname, '/contacts/search/duplicate');
    assert.equal(request.searchParams.get('locationId'), payload.locationId);
    if (request.searchParams.has('email')) {
      assert.equal(request.searchParams.get('email'), payload.email);
      assert.equal(request.searchParams.has('number'), false);
      return byEmail;
    }
    assert.equal(request.searchParams.get('number'), payload.phone);
    return byPhone;
  };
}

test('GHL workflow approval defaults off and applies to the audited location', () => {
  const env = { LLTOUCH_CM_GHL_AUTO_WORKFLOW_SAFETY_APPROVED: 'true' };
  assert.equal(campaignCrmWorkflowSafetyApproved({}, payload.locationId), false);
  assert.equal(campaignCrmWorkflowSafetyApproved(env, undefined), false);
  assert.equal(campaignCrmWorkflowSafetyApproved(env, payload.locationId), false);
  env.LLTOUCH_CM_GHL_VERIFIED_LOCATION_ID = 'different-location';
  assert.equal(campaignCrmWorkflowSafetyApproved(env, payload.locationId), false);
  env.LLTOUCH_CM_GHL_VERIFIED_LOCATION_ID = payload.locationId;
  assert.equal(campaignCrmWorkflowSafetyApproved(env, payload.locationId), true);
});

test('a new contact uses distinct email and phone lookups and the existing upsert payload', async () => {
  const lookup = duplicateSearch({ contact: null }, { contact: null });
  const existing = await findCampaignCrmContact(lookup, payload, normalizePhone);
  assert.equal(existing, null);
  const calls = [];
  const request = async (path, method, body) => {
    calls.push([path, method]);
    if (method === 'POST') {
      assert.deepEqual(body, payload);
      return { contact: { id: contact.id } };
    }
    return { contact: { ...contact, ...payload } };
  };
  assert.equal(await writeCampaignCrmContact(request, payload, existing, normalizePhone), contact.id);
  assert.deepEqual(calls, [['/contacts/upsert', 'POST'], ['/contacts/' + contact.id, 'GET']]);
});

test('an existing complete contact links without overwriting historical names or consent', async () => {
  const lookup = duplicateSearch({ contact }, { contact });
  const existing = await findCampaignCrmContact(lookup, payload, normalizePhone);
  assert.equal(existing, contact);
  assert.deepEqual(campaignCrmContactUpdate(payload, existing), {});
  assert.equal(await writeCampaignCrmContact(() => assert.fail('Completed contact should be linked without a write'),
    payload, existing, normalizePhone), contact.id);
  assert.equal(existing.name, 'Mariana Silva');
  assert.equal(existing.dnd, true);
  assert.equal(existing.sms_marketing_consent, false);
});

test('an exact contact update fills a missing identifier and preserves existing fields', async () => {
  const lookup = duplicateSearch({ contact: { ...contact, phone: null } }, { contact: null });
  const existing = await findCampaignCrmContact(lookup, payload, normalizePhone);
  assert.deepEqual(campaignCrmContactUpdate(payload, existing), { phone: payload.phone });
  const calls = [];
  const request = async (path, method, body) => {
    assert.equal(path, '/contacts/' + contact.id);
    calls.push(method);
    if (method === 'PUT') {
      assert.deepEqual(body, { phone: payload.phone });
      return { contact: { id: contact.id } };
    }
    return { contact };
  };
  assert.equal(await writeCampaignCrmContact(request, payload, existing, normalizePhone), contact.id);
  assert.deepEqual(calls, ['PUT', 'GET']);
});

test('an existing contact without any names can be given the submitted names', () => {
  const existing = { ...contact, firstName: null, lastName: null, name: null };
  assert.deepEqual(campaignCrmContactUpdate(payload, existing), {
    name: payload.name, firstName: payload.firstName, lastName: payload.lastName
  });
  assert.deepEqual(campaignCrmContactUpdate({ ...payload, name: 'Mariana', lastName: '' }, existing), {
    name: 'Mariana', firstName: 'Mariana'
  });
});

test('partial name records are filled only when every stored name field matches', () => {
  const existing = { ...contact, name: payload.name, firstName: null, lastName: null };
  assert.deepEqual(campaignCrmContactUpdate(payload, existing), {
    firstName: payload.firstName, lastName: payload.lastName
  });
  assert.deepEqual(campaignCrmContactUpdate(payload, { ...existing, name: 'Different name' }), {});
});

test('email and phone pointing to different contacts block all updates', async () => {
  const lookup = duplicateSearch({ contact }, { contact: { ...contact, id: 'another-contact' } });
  await assert.rejects(findCampaignCrmContact(lookup, payload, normalizePhone), /GHL_IDENTITY_CONFLICT/);
});

test('a single matching identity with conflicting previously stored data cannot be overwritten', async () => {
  const lookup = duplicateSearch({ contact }, { contact: { ...contact, email: 'other@example.invalid' } });
  await assert.rejects(findCampaignCrmContact(lookup, payload, normalizePhone), /GHL_IDENTITY_CONFLICT/);
});

test('lookup rejects missing result semantics and wrong-location IDs', async () => {
  const malformed = duplicateSearch({}, { contact: null });
  await assert.rejects(findCampaignCrmContact(malformed, payload, normalizePhone), /GHL_INVALID_RESPONSE/);
  const otherLocation = duplicateSearch({ contact: { ...contact, locationId: 'other-location' } }, { contact: null });
  await assert.rejects(findCampaignCrmContact(otherLocation, payload, normalizePhone), /GHL_INVALID_RESPONSE/);
});

test('duplicate search match is checked again by ID before classification', async () => {
  const stale = duplicateSearch({ contact }, { contact }, { ...contact, phone: null, email: null });
  await assert.rejects(findCampaignCrmContact(stale, payload, normalizePhone), /GHL_IDENTITY_CONFLICT/);
});

test('a lead without complete identity is blocked before a GHL request', async () => {
  const unexpectedRequest = () => assert.fail('A missing phone must block duplicate search');
  await assert.rejects(findCampaignCrmContact(unexpectedRequest, { ...payload, phone: '' }, normalizePhone),
    /GHL_INVALID_LEAD_IDENTITY/);
});

test('existing tags can be detected without redundant tag writes', async () => {
  const request = async (path, method) => {
    assert.equal(path, '/contacts/' + contact.id);
    assert.equal(method, 'GET');
    return { contact };
  };
  assert.equal(await campaignCrmContactHasTag(request, contact.id, payload, normalizePhone, 'lltouch-cm-lead'), true);
  assert.equal(await campaignCrmContactHasTag(request, contact.id, payload, normalizePhone, 'lltouch-cm-hydrafacial'), false);
});

test('a malformed tag response or changed contact identity blocks writes', async () => {
  const malformed = async () => ({ contact: { ...contact, tags: 'lltouch-cm-lead' } });
  await assert.rejects(campaignCrmContactHasTag(malformed, contact.id, payload, normalizePhone, 'lltouch-cm-lead'),
    /GHL_INVALID_RESPONSE/);
  const changed = async () => ({ contact: { ...contact, phone: '+17815550101' } });
  await assert.rejects(campaignCrmContactHasTag(changed, contact.id, payload, normalizePhone, 'lltouch-cm-lead'),
    /GHL_IDENTITY_CONFLICT/);
});

test('an update response must identify the same contact and persisted identity', async () => {
  const existing = { ...contact, phone: null };
  const wrongId = async () => ({ contact: { id: 'different-contact' } });
  await assert.rejects(writeCampaignCrmContact(wrongId, payload, existing, normalizePhone), /GHL_INVALID_RESPONSE/);
  const changed = async (_path, method) => (method === 'PUT' ? { contact: { id: contact.id } } :
    { contact: { ...contact, email: 'other@example.invalid' } });
  await assert.rejects(writeCampaignCrmContact(changed, payload, existing, normalizePhone), /GHL_IDENTITY_CONFLICT/);
});

test('new contacts are not marked synced if their submitted names and source did not persist', async () => {
  const request = async (_path, method) => method === 'POST' ? { contact: { id: contact.id } } : { contact };
  await assert.rejects(writeCampaignCrmContact(request, payload, null, normalizePhone), /GHL_INVALID_RESPONSE/);
});

test('a successful tag submission requires the tag to be present on the verified contact', async () => {
  const request = async (_path, method) => method === 'POST' ? null : { contact };
  await addCampaignCrmContactTag(request, contact.id, payload, normalizePhone, 'lltouch-cm-lead');
  await assert.rejects(addCampaignCrmContactTag(request, contact.id, payload, normalizePhone, 'lltouch-cm-hydrafacial'),
    /GHL_INVALID_RESPONSE/);
});

test('the contact transport pins the GHL API version, rejects redirects and permits only contact endpoints', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://services.leadconnectorhq.com');
    assert.equal(options.headers.Version, '2021-07-28');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic');
    return Response.json({ contact: null });
  });
  assert.deepEqual(await campaignCrmRequest('synthetic', '/contacts/search/duplicate', 'GET'), { contact: null });
  await assert.rejects(campaignCrmRequest('synthetic', 'https://unexpected.invalid/contacts/upsert', 'POST', payload),
    /GHL_INVALID_REQUEST/);
  await assert.rejects(campaignCrmRequest('synthetic', '/hooks/synthetic', 'POST', payload), /GHL_INVALID_REQUEST/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('the contact transport discards provider error bodies and bounds successful JSON', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ detail: 'synthetic private response detail' }, { status: 403 }));
  await assert.rejects(campaignCrmRequest('synthetic', '/contacts/upsert', 'POST', payload),
    { message: 'GHL HTTP 403' });
  fetch.mock.mockImplementation(async () => Response.json({ value: 'a'.repeat(512 * 1024) }));
  await assert.rejects(campaignCrmRequest('synthetic', '/contacts/' + contact.id, 'GET'),
    { message: 'GHL_INVALID_RESPONSE' });
});
