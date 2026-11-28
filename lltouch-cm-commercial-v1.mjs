const confirmations = Object.freeze({
  approve: 'APROVAR',
  publish: 'PUBLICAR',
  schedule: 'PROGRAMAR',
  pause: 'PAUSAR',
  end: 'ENCERRAR',
  revoke: 'REVOGAR',
  return_draft: 'REABRIR'
});

const reviewFields = ['pricingVerified', 'clinicalCopyReviewed', 'imagesReviewed', 'publicVisibilityAccepted'];
const providers = ['ludimilla', 'carol'];
const availabilitySources = ['Vagaro', 'Google Calendar', 'Supabase'];

export function validCommercialReviewToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readCommercialAction(body) {
  if (!record(body) || typeof body.action !== 'string' || !Object.hasOwn(confirmations, body.action) ||
      !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw Error('CM_COMMERCIAL_INPUT_INVALID');
  }
  const { action, expectedVersion, expectedRevision, confirmation, review, scheduledAt, availabilityDate, reviewToken } = body;
  const fields = ['action', 'expectedVersion', 'expectedRevision', 'confirmation'];
  if (action === 'approve') fields.push('review', 'availabilityDate', 'reviewToken');
  if (action === 'schedule') fields.push('scheduledAt');
  if (Object.keys(body).some(key => !fields.includes(key)) || confirmation !== confirmations[action]) {
    throw Error('CM_COMMERCIAL_CONFIRMATION_REQUIRED');
  }
  if (action === 'approve' && (!record(review) || Object.keys(review).length !== reviewFields.length ||
      reviewFields.some(key => review[key] !== true) ||
      typeof availabilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(availabilityDate))) {
    throw Error('CM_COMMERCIAL_REVIEW_REQUIRED');
  }
  if (action === 'approve' && !validCommercialReviewToken(reviewToken)) throw Error('CM_COMMERCIAL_REVIEW_STALE');
  if (action === 'schedule' && (typeof scheduledAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledAt) ||
      !Number.isFinite(Date.parse(scheduledAt)))) {
    throw Error('CM_COMMERCIAL_WINDOW_INVALID');
  }
  return { action, expectedVersion, expectedRevision, review, scheduledAt, availabilityDate, reviewToken };
}

export function commercialActions(campaign, authorization, ready, now = Date.now(), managed = false) {
  const status = campaign?.status;
  const ended = authorization?.state === 'ended';
  const editable = !ended && (status === 'draft' || status === 'paused');
  const approved = authorization?.state === 'approved' && authorization.version === campaign?.version;
  const starts = Date.parse(campaign?.offer_starts_at);
  const ends = Date.parse(campaign?.offer_ends_at);
  const canRelease = editable && ready && approved && ends >= Math.max(now, starts) + 600000;
  return {
    approve: editable && ready && !approved,
    publish: canRelease && starts <= now,
    schedule: canRelease && starts > now,
    pause: managed && status === 'published',
    end: managed && !ended && (status === 'published' || status === 'paused'),
    revoke: approved || authorization?.state === 'activated',
    return_draft: managed && !ended && status === 'paused'
  };
}

export async function commercialAvailabilityEvidence(contract, date, audit) {
  const results = await Promise.all(providers.map(providerKey => audit(contract.serviceKey, providerKey, date)));
  let slots = 0;
  for (const [index, result] of results.entries()) {
    if (result?.ok !== true || result.readOnly !== true || result.serviceKey !== contract.serviceKey ||
        result.providerKey !== providers[index] || result.date !== date ||
        result.durationMinutes !== contract.durationMinutes || result.timezone !== 'America/New_York' ||
        !Array.isArray(result.verifiedSources) || !availabilitySources.every(source => result.verifiedSources.includes(source)) ||
        !Array.isArray(result.slots) || result.slots.some(slot => typeof slot !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot))) {
      throw Error('CM_COMMERCIAL_AVAILABILITY_UNVERIFIED');
    }
    slots += new Set(result.slots).size;
  }
  if (!slots) throw Error('CM_COMMERCIAL_NO_AVAILABLE_SLOTS');
  return { date, checkedAt: new Date().toISOString(), providers: [...providers], sources: [...availabilitySources], slots };
}
