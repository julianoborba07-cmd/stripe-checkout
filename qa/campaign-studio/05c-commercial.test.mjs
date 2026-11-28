import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commercialActions, commercialAvailabilityEvidence, readCommercialAction } from '../../lltouch-cm-commercial-v1.mjs';

const review = { pricingVerified: true, clinicalCopyReviewed: true, imagesReviewed: true, publicVisibilityAccepted: true };
const action = { action: 'approve', expectedVersion: 2, expectedRevision: 0, confirmation: 'APROVAR',
  review, availabilityDate: '2031-03-12', reviewToken: 'a'.repeat(64) };
const schedule = { action: 'schedule', expectedVersion: 2, expectedRevision: 1, confirmation: 'PROGRAMAR',
  scheduledAt: '2031-03-20T04:00:00.000Z' };

test('requires explicit confirmation, campaign version and authorization revision', () => {
  assert.equal(readCommercialAction(action).expectedRevision, 0);
  for (const fields of [{ expectedRevision: undefined }, { expectedVersion: '2' }, { action: ['approve'] },
    { action: 'constructor' }, { confirmation: 'approve' }, { enableSms: true }]) {
    assert.throws(() => readCommercialAction({ ...action, ...fields }), /CM_COMMERCIAL_/);
  }
});

test('rejects incomplete review and client-supplied availability evidence', () => {
  for (const accepted of [false, 'true', null]) {
    assert.throws(() => readCommercialAction({ ...action, review: { ...review, clinicalCopyReviewed: accepted } }), /REVIEW_REQUIRED/);
  }
  assert.throws(() => readCommercialAction({ ...action, review: { ...review, availability: { slots: 5 } } }), /REVIEW_REQUIRED/);
  assert.throws(() => readCommercialAction({ ...action, availabilityDate: 'tomorrow' }), /REVIEW_REQUIRED/);
  for (const reviewToken of [undefined, 'a'.repeat(63), 'A'.repeat(64)]) {
    assert.throws(() => readCommercialAction({ ...action, reviewToken }), /REVIEW_STALE/);
  }
});

test('validates a schedule separately from an immediate publication', () => {
  assert.equal(readCommercialAction(schedule).scheduledAt, schedule.scheduledAt);
  assert.throws(() => readCommercialAction({ ...schedule, scheduledAt: 'invalid' }), /WINDOW_INVALID/);
  assert.throws(() => readCommercialAction({ ...schedule, scheduledAt: '2031-03-20' }), /WINDOW_INVALID/);
  assert.throws(() => readCommercialAction({ ...schedule, action: 'publish', confirmation: 'PUBLICAR' }), /CONFIRMATION_REQUIRED/);
});

const now = Date.parse('2031-03-20T04:00:00Z');
const campaign = { status: 'draft', version: 2, offer_starts_at: new Date(now).toISOString(),
  offer_ends_at: '2031-03-21T04:00:00Z' };
const approved = { state: 'approved', version: 2 };
test('publication actions depend on approval, exact version, readiness and time', () => {
  assert.equal(commercialActions(campaign, approved, true, now).publish, true);
  assert.equal(commercialActions(campaign, approved, true, now - 1).schedule, true);
  assert.equal(commercialActions(campaign, approved, true, now + 86400000 - 599999).publish, false);
  assert.equal(commercialActions(campaign, approved, false, now).publish, false);
  assert.equal(commercialActions({ ...campaign, version: 3 }, approved, true, now).publish, false);
  assert.equal(commercialActions({ ...campaign, version: 3 }, approved, true, now).approve, true);
});

test('pause, end and revoke remain available during an emergency release stop', () => {
  const current = commercialActions({ ...campaign, status: 'published' }, { ...approved, state: 'activated' }, false, now, true);
  assert.equal(current.pause && current.end && current.revoke, true);
  assert.equal(commercialActions({ ...campaign, status: 'paused' }, { state: 'ended' }, true, now, true).return_draft, false);
  assert.equal(commercialActions({ ...campaign, status: 'published' }, { state: 'unapproved' }, true, now).pause, false);
});

const contract = { serviceKey: 'hydrafacial', durationMinutes: 45 };
const date = action.availabilityDate;
const audit = (serviceKey, providerKey, date) => ({ ok: true, readOnly: true, serviceKey, providerKey, date,
  durationMinutes: 45, timezone: 'America/New_York', verifiedSources: ['Vagaro', 'Google Calendar', 'Supabase'],
  slots: providerKey === 'carol' ? ['10:00', '10:00', '14:30'] : [] });

test('records a date-specific sample from both assigned providers and all required sources', async () => {
  const result = await commercialAvailabilityEvidence(contract, date, audit);
  assert.deepEqual(result.providers, ['ludimilla', 'carol']);
  assert.deepEqual(result.sources, ['Vagaro', 'Google Calendar', 'Supabase']);
  assert.equal(result.date, date);
  assert.equal(result.slots, 2);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
});

test('fails closed on missing sources, mismatched duration, malformed times or no slots', async () => {
  for (const incomplete of [{ verifiedSources: ['Google Calendar', 'Supabase'] }, { durationMinutes: 30 },
    { providerKey: 'other' }, { slots: [null] }]) {
    await assert.rejects(() => commercialAvailabilityEvidence(contract, date,
      (...args) => ({ ...audit(...args), ...incomplete })), /AVAILABILITY_UNVERIFIED/);
  }
  await assert.rejects(() => commercialAvailabilityEvidence(contract, date,
    (...args) => ({ ...audit(...args), slots: [] })), /NO_AVAILABLE_SLOTS/);
});
