-- Candidate. Install only after the commercial PREVIEW prerequisites have been
-- independently verified in the target database. This file approves no campaign.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.lltouch_campaigns IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF to_regclass('public.lltouch_cm_lead_capture_settings') IS NULL OR
     to_regclass('public.lltouch_cm_leads') IS NULL OR
     to_regprocedure('public.lltouch_cm_lead_capture_configure(text,integer,boolean)') IS NULL OR
     to_regprocedure('public.lltouch_cm_lead_capture_submit(text,integer,uuid,text,text,text,boolean,boolean)') IS NULL THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_CAPTURE_SCHEMA_MISSING';
  END IF;
  IF EXISTS (SELECT FROM public.lltouch_campaigns WHERE
      marketing #> '{campaignMeta,mappedReservationAuthorized}' = 'true'::jsonb OR
      marketing #> '{campaignMeta,mappedCheckoutAuthorized}' = 'true'::jsonb) THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_UNTRACKED_RELEASE_PRESENT';
  END IF;
END;
$preflight$;

CREATE TABLE public.lltouch_cm_commercial_authorization_v1 (
  campaign_id uuid PRIMARY KEY REFERENCES public.lltouch_campaigns(id) ON DELETE RESTRICT,
  campaign_version integer NOT NULL CHECK (campaign_version > 0),
  campaign_status text NOT NULL CHECK (campaign_status IN ('draft', 'published', 'paused')),
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('approved', 'activated', 'revoked', 'ended', 'invalidated')),
  approved_at timestamptz NOT NULL,
  approved_by text NOT NULL,
  review jsonb NOT NULL CHECK (jsonb_typeof(review) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state <> 'activated' OR campaign_status = 'published') AND
         (state <> 'ended' OR campaign_status = 'paused'))
);

CREATE TABLE public.lltouch_cm_commercial_audit_v1 (
  campaign_id uuid NOT NULL REFERENCES public.lltouch_campaigns(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  from_version integer NOT NULL CHECK (from_version > 0),
  to_version integer NOT NULL CHECK (to_version > 0),
  action text NOT NULL CHECK (action IN ('approve', 'publish', 'schedule', 'revoke', 'pause', 'end',
    'return_draft', 'campaign_changed', 'assets_changed')),
  actor text NOT NULL,
  review jsonb NOT NULL CHECK (jsonb_typeof(review) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (campaign_id, revision)
);

ALTER TABLE public.lltouch_cm_commercial_authorization_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lltouch_cm_commercial_audit_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lltouch_cm_commercial_authorization_v1, public.lltouch_cm_commercial_audit_v1
  FROM PUBLIC, anon, authenticated, service_role;

-- Compare reviewed terms without the operational markers derived here.
CREATE FUNCTION public.lltouch_cm_commercial_material_v1(c public.lltouch_campaigns)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT (to_jsonb(c) - ARRAY['status', 'version', 'updated_at', 'published_at', 'marketing']) ||
    jsonb_build_object('marketing', c.marketing - 'campaignMeta', 'campaignMeta',
      (c.marketing->'campaignMeta') - ARRAY['releaseMode', 'bookingReady', 'checkoutReady',
        'commercialManaged', 'mappedReservationAuthorized', 'mappedCheckoutAuthorized']);
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_review_token_v1(c public.lltouch_campaigns)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp SET timezone = 'UTC' AS $fn$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'version', c.version, 'status', c.status, 'terms', public.lltouch_cm_commercial_material_v1(c),
    'assets', COALESCE(jsonb_agg(asset.material ORDER BY asset.material), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
  FROM (SELECT to_jsonb(a) - ARRAY['updated_at', 'created_at'] AS material
        FROM public.lltouch_campaign_assets a WHERE a.campaign_id = c.id) asset;
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_active_v1(p_campaign_id uuid, p_version integer)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT FROM public.lltouch_cm_commercial_authorization_v1 a
    JOIN public.lltouch_campaigns c ON c.id = a.campaign_id
    WHERE c.id = p_campaign_id AND c.version = p_version AND a.campaign_version = c.version
      AND a.state = 'activated' AND c.status = 'published' AND a.campaign_status = 'published'
      AND c.marketing #> '{campaignMeta,mappedReservationAuthorized}' = 'true'::jsonb
      AND c.marketing #> '{campaignMeta,mappedCheckoutAuthorized}' = 'true'::jsonb
      AND c.offer_starts_at <= clock_timestamp() AND c.offer_ends_at > clock_timestamp()
  );
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_status_v1(p_campaign_key text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'ok', true, 'managed', a.campaign_id IS NOT NULL, 'campaignKey', c.campaign_key,
      'version', c.version, 'status', c.status, 'reviewToken', public.lltouch_cm_commercial_review_token_v1(c), 'scheduleState', CASE
        WHEN c.status <> 'published' THEN 'not-published'
        WHEN c.offer_starts_at IS NULL OR c.offer_ends_at IS NULL OR c.offer_starts_at >= c.offer_ends_at
          THEN 'invalid-dates'
        WHEN c.offer_starts_at > statement_timestamp() THEN 'scheduled'
        WHEN c.offer_ends_at <= statement_timestamp() THEN 'ended'
        ELSE 'active' END,
      'authorization', jsonb_build_object('state', COALESCE(a.state, 'unapproved'),
        'active', public.lltouch_cm_commercial_active_v1(c.id, c.version), 'version', a.campaign_version,
        'revision', COALESCE(a.revision, 0), 'approvedAt', a.approved_at, 'approvedBy', a.approved_by,
        'updatedAt', a.updated_at, 'availability', a.review->'availability',
        'lastAction', history.action, 'lastActor', history.actor))
    FROM public.lltouch_campaigns c LEFT JOIN public.lltouch_cm_commercial_authorization_v1 a ON a.campaign_id = c.id
    LEFT JOIN public.lltouch_cm_commercial_audit_v1 history ON history.campaign_id = a.campaign_id AND history.revision = a.revision
    WHERE c.campaign_key = p_campaign_key
  ), jsonb_build_object('ok', false, 'error', 'CM_COMMERCIAL_NOT_FOUND'));
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_disable_capture_v1(p_key text)
RETURNS void LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $fn$
  UPDATE public.lltouch_cm_lead_capture_settings
  SET enabled = false, revision = revision + 1, updated_at = clock_timestamp()
  WHERE campaign_key = p_key AND enabled;
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_invalidate_v1(c public.lltouch_campaigns, p_action text, p_to_version integer)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE changed public.lltouch_cm_commercial_authorization_v1%ROWTYPE;
BEGIN
  UPDATE public.lltouch_cm_commercial_authorization_v1
  SET state = 'invalidated', revision = revision + 1, updated_at = clock_timestamp()
  WHERE campaign_id = c.id AND state IN ('approved', 'activated')
  RETURNING * INTO changed;
  IF FOUND THEN
    PERFORM public.lltouch_cm_commercial_disable_capture_v1(c.campaign_key);
    INSERT INTO public.lltouch_cm_commercial_audit_v1
      (campaign_id, revision, from_version, to_version, action, actor, review)
    VALUES (c.id, changed.revision, c.version, p_to_version, p_action, 'database', '{}'::jsonb);
  END IF;
END;
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_campaign_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  a public.lltouch_cm_commercial_authorization_v1%ROWTYPE;
  meta jsonb := NEW.marketing->'campaignMeta';
  transitioned boolean := false;
  enabled boolean;
BEGIN
  SELECT * INTO a FROM public.lltouch_cm_commercial_authorization_v1 WHERE campaign_id = NEW.id;

  IF TG_OP = 'UPDATE' THEN
    transitioned := NEW.status IS DISTINCT FROM OLD.status;
    IF a.campaign_id IS NOT NULL AND transitioned AND
       (a.campaign_version IS DISTINCT FROM NEW.version OR a.campaign_version <= OLD.version OR
        a.campaign_status IS DISTINCT FROM NEW.status::text) THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_LIFECYCLE_REQUIRED';
    END IF;
    IF a.campaign_id IS NOT NULL AND a.state IN ('approved', 'activated') AND
       ((NOT transitioned AND NEW.version IS DISTINCT FROM OLD.version) OR
         public.lltouch_cm_commercial_material_v1(NEW) IS DISTINCT FROM public.lltouch_cm_commercial_material_v1(OLD)) THEN
      IF transitioned THEN RAISE EXCEPTION 'CM_COMMERCIAL_MATERIAL_CHANGED'; END IF;
      PERFORM public.lltouch_cm_commercial_invalidate_v1(OLD, 'campaign_changed', NEW.version);
      a.state := 'invalidated';
    END IF;
  END IF;

  IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR transitioned) THEN
    -- The universal pages select one published campaign. Serialize this check
    -- across both the commercial and legacy display publication paths.
    PERFORM pg_advisory_xact_lock(hashtext('llt_cm_commercial_publication'), 1);
    IF EXISTS (SELECT FROM public.lltouch_campaigns WHERE status = 'published' AND id <> NEW.id) THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_ANOTHER_PUBLISHED';
    END IF;
  END IF;

  enabled := a.state IS NOT DISTINCT FROM 'activated' AND a.campaign_version = NEW.version AND
    a.campaign_status = NEW.status::text AND NEW.status = 'published';
  IF a.campaign_id IS NOT NULL OR meta ?| ARRAY['commercialManaged', 'mappedReservationAuthorized', 'mappedCheckoutAuthorized'] THEN
    meta := COALESCE(meta, '{}'::jsonb) - ARRAY['commercialManaged', 'mappedReservationAuthorized', 'mappedCheckoutAuthorized'];
    IF a.campaign_id IS NOT NULL THEN
      meta := meta || jsonb_build_object('commercialManaged', true,
        'mappedReservationAuthorized', COALESCE(enabled, false), 'mappedCheckoutAuthorized', COALESCE(enabled, false),
        'bookingReady', false, 'checkoutReady', false,
        'releaseMode', CASE NEW.status::text WHEN 'published' THEN 'display-only' WHEN 'paused' THEN 'paused' ELSE 'draft' END);
    END IF;
    NEW.marketing := jsonb_set(COALESCE(NEW.marketing, '{}'::jsonb), '{campaignMeta}', meta, true);
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER lltouch_cm_commercial_campaign_guard_v1
BEFORE INSERT OR UPDATE ON public.lltouch_campaigns FOR EACH ROW
EXECUTE FUNCTION public.lltouch_cm_commercial_campaign_guard_v1();

CREATE FUNCTION public.lltouch_cm_commercial_asset_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  old_campaign uuid;
  new_campaign uuid;
  c public.lltouch_campaigns%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_campaign := OLD.campaign_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_campaign := NEW.campaign_id; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'updated_at') = (to_jsonb(NEW) - 'updated_at') THEN RETURN NULL; END IF;

  FOR c IN SELECT * FROM public.lltouch_campaigns WHERE id IN (old_campaign, new_campaign) ORDER BY id FOR UPDATE LOOP
    IF EXISTS (SELECT FROM public.lltouch_cm_commercial_authorization_v1
        WHERE campaign_id = c.id AND state IN ('approved','activated')) THEN
      PERFORM public.lltouch_cm_commercial_invalidate_v1(c, 'assets_changed', c.version);
      -- Derive inactive flags through the campaign guard in the same transaction.
      UPDATE public.lltouch_campaigns SET marketing = c.marketing WHERE id = c.id;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;

CREATE TRIGGER lltouch_cm_commercial_asset_guard_v1
AFTER INSERT OR UPDATE OR DELETE ON public.lltouch_campaign_assets FOR EACH ROW
EXECUTE FUNCTION public.lltouch_cm_commercial_asset_guard_v1();

CREATE FUNCTION public.lltouch_cm_commercial_capture_setting_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE c public.lltouch_campaigns%ROWTYPE; a public.lltouch_cm_commercial_authorization_v1%ROWTYPE;
BEGIN
  IF NEW.enabled IS DISTINCT FROM true THEN RETURN NEW; END IF;
  -- Lifecycle locks campaign then settings. This guard can run after a legacy
  -- writer has locked the setting, so it reads campaign state without locking
  -- it. Revocation also disables the setting, and lead writes take the campaign lock.
  SELECT * INTO c FROM public.lltouch_campaigns WHERE campaign_key = NEW.campaign_key;
  SELECT * INTO a FROM public.lltouch_cm_commercial_authorization_v1 WHERE campaign_id = c.id;
  IF FOUND AND (a.state <> 'activated' OR a.campaign_version IS DISTINCT FROM c.version OR
      NEW.campaign_version IS DISTINCT FROM c.version OR c.status IS DISTINCT FROM 'published' OR
      c.offer_ends_at IS NULL OR c.offer_ends_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_CAPTURE_INACTIVE';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER lltouch_cm_commercial_capture_setting_guard_v1
BEFORE INSERT OR UPDATE ON public.lltouch_cm_lead_capture_settings FOR EACH ROW
EXECUTE FUNCTION public.lltouch_cm_commercial_capture_setting_guard_v1();

CREATE FUNCTION public.lltouch_cm_commercial_lead_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE c public.lltouch_campaigns%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.lltouch_campaigns WHERE id = NEW.campaign_id FOR SHARE;
  IF EXISTS (SELECT FROM public.lltouch_cm_commercial_authorization_v1 WHERE campaign_id = c.id) AND
     (NEW.campaign_key IS DISTINCT FROM c.campaign_key OR NOT public.lltouch_cm_commercial_active_v1(c.id, NEW.campaign_version)) THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_CAPTURE_INACTIVE';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER lltouch_cm_commercial_lead_guard_v1
BEFORE INSERT ON public.lltouch_cm_leads FOR EACH ROW
EXECUTE FUNCTION public.lltouch_cm_commercial_lead_guard_v1();

CREATE FUNCTION public.lltouch_cm_commercial_assert_plan_v1(c public.lltouch_campaigns)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  meta jsonb := c.marketing->'campaignMeta';
  plan jsonb := meta->'automationPlan';
  service_key text := plan->>'serviceKey';
  expected_type text;
BEGIN
  IF c.site_item->>'type' IS DISTINCT FROM 'manual' OR
     c.site_item->'requiresVagaroMapping' IS DISTINCT FROM 'true'::jsonb OR
     c.currency IS DISTINCT FROM 'usd' OR c.timezone IS DISTINCT FROM 'America/New_York' OR
     c.hold_minutes IS DISTINCT FROM 10 OR c.regular_price_cents IS NULL OR c.price_cents IS NULL OR
     c.deposit_cents IS NULL OR c.deposit_cents NOT BETWEEN 50 AND 99999999 OR c.price_cents < c.deposit_cents OR
     c.regular_price_cents <= c.price_cents THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_TERMS_INVALID';
  END IF;
  expected_type := CASE
    WHEN service_key IN ('hydrafacial','microneedling','llumigold') THEN 'med-spa'
    WHEN service_key IN ('ll-signature','classic-deluxe','diamond-glow','dermaplaning') THEN 'facial'
  END;
  IF plan->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR expected_type IS NULL OR
     plan->>'mappingStatus' IS DISTINCT FROM 'local-catalog-match' OR
     plan->'siteItem' IS DISTINCT FROM jsonb_build_object('type', expected_type, 'service', service_key,
       'package', 'single', 'addon', 'none', 'quantity', 1) OR
     plan->'providerKeys' IS DISTINCT FROM '["ludimilla","carol"]'::jsonb OR
     jsonb_typeof(plan->'durationMinutes') IS DISTINCT FROM 'number' OR
     NOT COALESCE(plan->>'durationMinutes' ~ '^[0-9]{2,3}$', false) OR
     plan->'holdMinutes' IS DISTINCT FROM to_jsonb(c.hold_minutes) OR
     plan->'priceCents' IS DISTINCT FROM to_jsonb(c.price_cents) OR plan->'depositCents' IS DISTINCT FROM to_jsonb(c.deposit_cents) OR
     plan->'balanceCents' IS DISTINCT FROM to_jsonb(c.price_cents - c.deposit_cents) OR
     (meta #> '{serviceTerms,sessions}' IS NOT NULL AND meta #> '{serviceTerms,sessions}' NOT IN ('1'::jsonb,'null'::jsonb)) OR
     meta #> '{serviceTerms,singleAreaForAllSessions}' = 'true'::jsonb THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_PLAN_INVALID';
  END IF;
  IF (plan->>'durationMinutes')::integer NOT BETWEEN 10 AND 240 THEN RAISE EXCEPTION 'CM_COMMERCIAL_PLAN_INVALID'; END IF;
  IF c.offer_starts_at IS NULL OR c.offer_ends_at IS NULL OR NOT isfinite(c.offer_starts_at) OR
     NOT isfinite(c.offer_ends_at) OR c.offer_starts_at >= c.offer_ends_at OR
     c.offer_starts_at + interval '10 minutes' > c.offer_ends_at OR c.offer_ends_at <= clock_timestamp() OR
     c.offer_ends_at - c.offer_starts_at > interval '91 days' THEN RAISE EXCEPTION 'CM_COMMERCIAL_WINDOW_INVALID'; END IF;
  IF length(btrim(COALESCE(c.service_title, ''))) < 3 OR length(btrim(COALESCE(c.marketing->>'headline', ''))) < 4 OR
     length(btrim(COALESCE(c.marketing->>'description', ''))) < 15 THEN RAISE EXCEPTION 'CM_COMMERCIAL_CONTENT_INVALID'; END IF;
  IF (SELECT count(DISTINCT device) FROM public.lltouch_campaign_assets
      WHERE campaign_id = c.id AND asset_type = 'hero' AND position = 0 AND device IN ('desktop', 'mobile')
        AND length(image_url) <= 2048 AND image_url ~* '^https://[^/@[:space:]<>"''?]+([/?][^[:space:]<>"'']*)?$') <> 2 THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_ASSETS_INVALID';
  END IF;
END;
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_lifecycle_v1(
  p_campaign_key text, p_expected_version integer, p_expected_revision integer, p_action text, p_actor text,
  p_review jsonb DEFAULT '{}'::jsonb, p_scheduled_at timestamptz DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  c public.lltouch_campaigns%ROWTYPE;
  a public.lltouch_cm_commercial_authorization_v1%ROWTYPE;
  next_status text;
  next_state text;
  next_version integer;
  next_revision integer;
  activation boolean := p_action IN ('publish', 'schedule');
  review jsonb := '{}'::jsonb;
  availability jsonb;
  checked_at timestamptz;
  moment timestamptz;
BEGIN
  IF p_campaign_key IS NULL OR p_campaign_key !~ '^[a-z0-9][a-z0-9-]{3,95}$' OR
     p_expected_version IS NULL OR p_expected_version < 1 OR p_expected_revision IS NULL OR p_expected_revision < 0 OR
     p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 160 OR p_actor ~ '[[:cntrl:]]' OR
     p_action IS NULL OR p_action NOT IN ('approve', 'publish', 'schedule', 'revoke', 'pause', 'end', 'return_draft') OR
     (p_action <> 'schedule' AND p_scheduled_at IS NOT NULL) THEN RAISE EXCEPTION 'CM_COMMERCIAL_INPUT_INVALID'; END IF;

  SELECT * INTO c FROM public.lltouch_campaigns WHERE campaign_key = p_campaign_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CM_COMMERCIAL_NOT_FOUND'; END IF;
  moment := clock_timestamp();
  IF c.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'CM_COMMERCIAL_VERSION_CONFLICT'; END IF;
  SELECT * INTO a FROM public.lltouch_cm_commercial_authorization_v1 WHERE campaign_id = c.id;
  IF COALESCE(a.revision, 0) <> p_expected_revision THEN RAISE EXCEPTION 'CM_COMMERCIAL_REVISION_CONFLICT'; END IF;
  IF a.state = 'ended' THEN RAISE EXCEPTION 'CM_COMMERCIAL_STATE_CONFLICT'; END IF;

  next_status := c.status::text;
  next_version := c.version;
  next_revision := COALESCE(a.revision, 0) + 1;
  IF p_action = 'approve' OR activation THEN
    IF c.status NOT IN ('draft', 'paused') THEN RAISE EXCEPTION 'CM_COMMERCIAL_STATE_CONFLICT'; END IF;
    PERFORM public.lltouch_cm_commercial_assert_plan_v1(c);
  END IF;

  IF p_action = 'approve' THEN
    IF p_review->'pricingVerified' IS DISTINCT FROM 'true'::jsonb OR
       p_review->'clinicalCopyReviewed' IS DISTINCT FROM 'true'::jsonb OR
       p_review->'imagesReviewed' IS DISTINCT FROM 'true'::jsonb OR
       p_review->'publicVisibilityAccepted' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_REVIEW_REQUIRED';
    END IF;
    IF p_review->>'reviewToken' IS DISTINCT FROM public.lltouch_cm_commercial_review_token_v1(c) THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_REVIEW_STALE';
    END IF;
    availability := p_review->'availability';
    IF NOT COALESCE(availability->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', false) OR
       availability->'providers' IS DISTINCT FROM '["ludimilla","carol"]'::jsonb OR
       availability->'sources' IS DISTINCT FROM '["Vagaro","Google Calendar","Supabase"]'::jsonb OR
       jsonb_typeof(availability->'slots') IS DISTINCT FROM 'number' OR
       NOT COALESCE(availability->>'slots' ~ '^[1-9][0-9]{0,5}$', false) THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_AVAILABILITY_REQUIRED';
    END IF;
    BEGIN
      checked_at := (availability->>'checkedAt')::timestamptz;
      PERFORM (availability->>'date')::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_AVAILABILITY_REQUIRED';
    END;
    IF checked_at IS NULL OR checked_at < moment - interval '5 minutes' OR checked_at > moment + interval '1 minute' THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_AVAILABILITY_REQUIRED';
    END IF;
    review := jsonb_build_object('reviewToken', p_review->>'reviewToken',
      'pricingVerified', true, 'clinicalCopyReviewed', true, 'imagesReviewed', true,
      'publicVisibilityAccepted', true, 'availability', jsonb_build_object('date', availability->'date',
        'checkedAt', checked_at, 'providers', availability->'providers', 'sources', availability->'sources', 'slots', availability->'slots'));
    INSERT INTO public.lltouch_cm_commercial_authorization_v1
      (campaign_id, campaign_version, campaign_status, revision, state, approved_at, approved_by, review)
    VALUES (c.id, c.version, next_status, next_revision, 'approved', moment, p_actor, review)
    ON CONFLICT (campaign_id) DO UPDATE SET campaign_version = excluded.campaign_version,
      campaign_status = excluded.campaign_status, revision = excluded.revision, state = excluded.state,
      approved_at = excluded.approved_at, approved_by = excluded.approved_by, review = excluded.review, updated_at = moment;
  ELSE
    IF a.campaign_id IS NULL THEN RAISE EXCEPTION 'CM_COMMERCIAL_APPROVAL_REQUIRED'; END IF;
    IF activation THEN
      IF a.state <> 'approved' OR a.campaign_version <> c.version OR a.campaign_status <> c.status::text THEN
        RAISE EXCEPTION 'CM_COMMERCIAL_APPROVAL_REQUIRED';
      END IF;
      IF (p_action = 'publish' AND (c.offer_starts_at > moment OR c.offer_ends_at < moment + interval '10 minutes')) OR
         (p_action = 'schedule' AND (p_scheduled_at IS DISTINCT FROM c.offer_starts_at OR p_scheduled_at <= moment)) THEN
        RAISE EXCEPTION 'CM_COMMERCIAL_WINDOW_INVALID';
      END IF;
      next_status := 'published';
      next_state := 'activated';
    ELSIF p_action = 'return_draft' THEN
      IF c.status <> 'paused' THEN RAISE EXCEPTION 'CM_COMMERCIAL_STATE_CONFLICT'; END IF;
      next_status := 'draft';
      next_state := 'invalidated';
    ELSIF p_action IN ('pause', 'end') THEN
      IF c.status <> 'published' AND (p_action = 'pause' OR c.status <> 'paused') THEN
        RAISE EXCEPTION 'CM_COMMERCIAL_STATE_CONFLICT';
      END IF;
      next_status := 'paused';
      next_state := CASE WHEN p_action = 'end' THEN 'ended' ELSE 'revoked' END;
    ELSE
      IF a.state NOT IN ('approved', 'activated') THEN RAISE EXCEPTION 'CM_COMMERCIAL_STATE_CONFLICT'; END IF;
      next_state := 'revoked';
    END IF;

    IF next_status <> c.status::text THEN next_version := c.version + 1; END IF;
    UPDATE public.lltouch_cm_commercial_authorization_v1
    SET campaign_version = next_version, campaign_status = next_status, state = next_state,
        revision = next_revision, updated_at = moment
    WHERE campaign_id = c.id;
  END IF;

  IF NOT activation THEN PERFORM public.lltouch_cm_commercial_disable_capture_v1(c.campaign_key); END IF;
  IF next_status IS DISTINCT FROM c.status::text THEN
    UPDATE public.lltouch_campaigns SET version = next_version,
      status = (jsonb_populate_record(NULL::public.lltouch_campaigns, jsonb_build_object('status', next_status))).status
    WHERE id = c.id;
  ELSE
    UPDATE public.lltouch_campaigns SET marketing = c.marketing WHERE id = c.id;
  END IF;

  IF activation THEN
    PERFORM public.lltouch_cm_lead_capture_configure(c.campaign_key, next_version, true);
    IF NOT EXISTS (SELECT FROM public.lltouch_cm_lead_capture_settings
        WHERE campaign_key = c.campaign_key AND campaign_version = next_version AND enabled) THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_CAPTURE_NOT_CONFIGURED';
    END IF;
  END IF;
  INSERT INTO public.lltouch_cm_commercial_audit_v1
    (campaign_id, revision, from_version, to_version, action, actor, review)
  VALUES (c.id, next_revision, c.version, next_version, p_action, p_actor, review);

  -- Call status in a new SQL statement after all state changes.
  RETURN public.lltouch_cm_commercial_status_v1(c.campaign_key);
END;
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_submit_v1(
  p_campaign_key text, p_campaign_version integer, p_client_nonce uuid,
  p_customer_name text, p_customer_email text, p_customer_phone text,
  p_contact_consent boolean, p_sms_marketing_consent boolean
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE c public.lltouch_campaigns%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.lltouch_campaigns WHERE campaign_key = p_campaign_key FOR SHARE;
  IF NOT FOUND OR NOT public.lltouch_cm_commercial_active_v1(c.id, p_campaign_version) THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_CAPTURE_INACTIVE';
  END IF;
  RETURN public.lltouch_cm_lead_capture_submit(p_campaign_key, p_campaign_version, p_client_nonce,
    p_customer_name, p_customer_email, p_customer_phone, p_contact_consent, p_sms_marketing_consent);
END;
$fn$;

REVOKE ALL ON FUNCTION public.lltouch_cm_commercial_material_v1(public.lltouch_campaigns),
  public.lltouch_cm_commercial_review_token_v1(public.lltouch_campaigns),
  public.lltouch_cm_commercial_assert_plan_v1(public.lltouch_campaigns), public.lltouch_cm_commercial_disable_capture_v1(text),
  public.lltouch_cm_commercial_invalidate_v1(public.lltouch_campaigns,text,integer), public.lltouch_cm_commercial_campaign_guard_v1(),
  public.lltouch_cm_commercial_asset_guard_v1(), public.lltouch_cm_commercial_capture_setting_guard_v1(),
  public.lltouch_cm_commercial_lead_guard_v1(), public.lltouch_cm_commercial_active_v1(uuid,integer),
  public.lltouch_cm_commercial_status_v1(text), public.lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz),
  public.lltouch_cm_commercial_submit_v1(text,integer,uuid,text,text,text,boolean,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lltouch_cm_commercial_active_v1(uuid,integer), public.lltouch_cm_commercial_status_v1(text),
  public.lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz),
  public.lltouch_cm_commercial_submit_v1(text,integer,uuid,text,text,text,boolean,boolean) TO service_role;

COMMIT;
