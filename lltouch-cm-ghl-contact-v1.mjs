const contactIdPattern = /^[A-Za-z0-9_-]{6,120}$/;
const contactApiOrigin = 'https://services.leadconnectorhq.com';
const contactApiVersion = '2021-07-28';
const contactResponseLimit = 512 * 1024;
const contactPaths = {
  GET: /^\/contacts\/(?:search\/duplicate|[A-Za-z0-9_-]{6,120})$/,
  POST: /^\/contacts\/(?:upsert|[A-Za-z0-9_-]{6,120}\/tags)$/,
  PUT: /^\/contacts\/[A-Za-z0-9_-]{6,120}$/
};

export async function campaignCrmRequest(token, path, method, payload) {
  const url = new URL(path, contactApiOrigin);
  if (!token || url.origin !== contactApiOrigin || !Object.hasOwn(contactPaths, method) ||
    !contactPaths[method].test(url.pathname)) {
    throw new Error('GHL_INVALID_REQUEST');
  }
  const response = await fetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: 'Bearer ' + token, Version: contactApiVersion,
      Accept: 'application/json', 'Content-Type': 'application/json'
    },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`GHL HTTP ${response.status}`);
  }
  if (response.status === 204) return null;
  if (!response.body) throw new Error('GHL_INVALID_RESPONSE');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let json = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > contactResponseLimit) throw new Error('GHL_INVALID_RESPONSE');
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('GHL_INVALID_RESPONSE');
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function campaignCrmWorkflowSafetyApproved(env, locationId) {
  return typeof locationId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(locationId) &&
    env.LLTOUCH_CM_GHL_AUTO_WORKFLOW_SAFETY_APPROVED === 'true' &&
    env.LLTOUCH_CM_GHL_VERIFIED_LOCATION_ID === locationId;
}

function validateCrmContact(contact, locationId, contactId) {
  if (!contact || typeof contact.id !== 'string' || !contactIdPattern.test(contact.id) ||
    contact.locationId !== locationId || (contactId && contact.id !== contactId)) {
    throw new Error('GHL_INVALID_RESPONSE');
  }
  return contact;
}

function matchesIdentity(contact, payload, normalizePhone, { allowMissing = false } = {}) {
  const email = typeof contact.email === 'string' ? contact.email.trim().toLowerCase() : null;
  const phone = typeof contact.phone === 'string' ? normalizePhone(contact.phone) : null;
  const missing = value => value == null || value === '';
  const sameEmail = email === payload.email;
  const samePhone = phone === payload.phone;
  return Boolean(payload.email && payload.phone) && (sameEmail || samePhone) &&
    (sameEmail || (allowMissing && missing(contact.email))) &&
    (samePhone || (allowMissing && missing(contact.phone)));
}

function sameContactText(actual, requested) {
  const normalize = value => value.normalize('NFC').trim().replace(/\s+/g, ' ');
  return typeof actual === 'string' && normalize(actual) === normalize(requested);
}

async function readCampaignCrmContact(request, contactId, payload, normalizePhone, options) {
  const result = await request('/contacts/' + encodeURIComponent(contactId), 'GET');
  const contact = validateCrmContact(result?.contact, payload.locationId, contactId);
  if (!matchesIdentity(contact, payload, normalizePhone, options)) throw new Error('GHL_IDENTITY_CONFLICT');
  return contact;
}

export async function findCampaignCrmContact(request, payload, normalizePhone) {
  if (!payload.email || !payload.phone) throw new Error('GHL_INVALID_LEAD_IDENTITY');
  async function findBy(field, value) {
    const query = new URLSearchParams({ locationId: payload.locationId, [field]: value });
    const response = await request('/contacts/search/duplicate?' + query, 'GET');
    if (response?.contact === null) return null;
    const contact = validateCrmContact(response?.contact, payload.locationId);
    const actual = field === 'email' ? String(contact.email || '').trim().toLowerCase() :
      normalizePhone(contact.phone);
    if (actual !== value) throw new Error('GHL_IDENTITY_CONFLICT');
    return contact;
  }

  // Search each key independently. A combined lookup follows the location's
  // preferred key and can hide a conflict with the second identifier.
  const [byEmail, byPhone] = await Promise.all([
    findBy('email', payload.email), findBy('number', payload.phone)
  ]);
  if (byEmail && byPhone && byEmail.id !== byPhone.id) throw new Error('GHL_IDENTITY_CONFLICT');
  for (const contact of [byEmail, byPhone]) {
    if (contact && !matchesIdentity(contact, payload, normalizePhone, { allowMissing: true })) {
      throw new Error('GHL_IDENTITY_CONFLICT');
    }
  }
  const match = byEmail || byPhone;
  return match ? readCampaignCrmContact(request, match.id, payload, normalizePhone, { allowMissing: true }) : null;
}

export function campaignCrmContactUpdate(payload, existing) {
  // Leave prior attribution, names and messaging preferences on the CRM contact.
  // Fill name components only when each stored name field agrees with the lead.
  const changes = {};
  if (!existing.email) changes.email = payload.email;
  if (!existing.phone) changes.phone = payload.phone;
  const nameFields = ['name', 'firstName', 'lastName'];
  if (nameFields.every(field => !existing[field] || sameContactText(existing[field], payload[field] ?? ''))) {
    if (nameFields.every(field => !existing[field])) changes.name = payload.name;
    if (!existing.firstName) changes.firstName = payload.firstName;
    if (!existing.lastName && payload.lastName) changes.lastName = payload.lastName;
  }
  return changes;
}

export async function writeCampaignCrmContact(request, payload, existing, normalizePhone) {
  const changes = existing ? campaignCrmContactUpdate(payload, existing) : payload;
  if (Object.keys(changes).length === 0) return existing.id;
  const response = existing ? await request('/contacts/' + encodeURIComponent(existing.id), 'PUT', changes) :
    await request('/contacts/upsert', 'POST', changes);
  const contact = response?.contact;
  if (typeof contact?.id !== 'string' || !contactIdPattern.test(contact.id) ||
    (existing && contact.id !== existing.id) || (contact.locationId != null && contact.locationId !== payload.locationId)) {
    throw new Error('GHL_INVALID_RESPONSE');
  }
  // Mutations can return a partial record. Verify identity and written contact
  // fields before reporting a durable sync.
  const persisted = await readCampaignCrmContact(request, contact.id, payload, normalizePhone);
  for (const field of ['firstName', 'lastName', 'source']) {
    if (Object.hasOwn(changes, field) && !sameContactText(persisted[field], changes[field])) {
      throw new Error('GHL_INVALID_RESPONSE');
    }
  }
  return persisted.id;
}

export async function campaignCrmContactHasTag(request, contactId, payload, normalizePhone, tag) {
  const { tags } = await readCampaignCrmContact(request, contactId, payload, normalizePhone);
  if (!Array.isArray(tags) || tags.some(value => typeof value !== 'string')) {
    throw new Error('GHL_INVALID_RESPONSE');
  }
  return tags.some(value => value.trim().toLowerCase() === tag);
}

export async function addCampaignCrmContactTag(request, contactId, payload, normalizePhone, tag) {
  await request('/contacts/' + encodeURIComponent(contactId) + '/tags', 'POST', { tags: [tag] });
  if (!await campaignCrmContactHasTag(request, contactId, payload, normalizePhone, tag)) {
    throw new Error('GHL_INVALID_RESPONSE');
  }
}
