\set ON_ERROR_STOP on
BEGIN;
DO $local$
BEGIN
  IF current_database() <> 'lltouch_authorization_qa' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Use the isolated authorization test database over its Unix socket';
  END IF;
END;
$local$;

CREATE FUNCTION pg_temp.assert_ok(result boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF result IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
END;
$$;

CREATE FUNCTION pg_temp.expect_failure(statement text, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = message THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'Expected failure: %', message;
END;
$$;

CREATE FUNCTION pg_temp.review(p_key text DEFAULT 'hydrafacial-piloto-qa') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('reviewToken', public.lltouch_cm_commercial_status_v1(p_key)->>'reviewToken',
    'pricingVerified', true, 'clinicalCopyReviewed', true, 'imagesReviewed', true,
    'publicVisibilityAccepted', true, 'availability', jsonb_build_object('date', current_date + 2,
      'checkedAt', clock_timestamp(), 'providers', '["ludimilla","carol"]'::jsonb,
      'sources', '["Vagaro","Google Calendar","Supabase"]'::jsonb, 'slots', 3));
$$;

INSERT INTO public.lltouch_campaigns(campaign_key, version, status, site_item, service_title, marketing,
  regular_price_cents, price_cents, deposit_cents, offer_starts_at, offer_ends_at)
SELECT k, 2, 'draft', '{"type":"manual","requiresVagaroMapping":true}'::jsonb, title,
  jsonb_build_object('headline', 'An approved seasonal offer', 'description', 'Offer content reviewed for the public campaign.',
    'campaignMeta', jsonb_build_object('automationPlan', jsonb_build_object('schemaVersion', 1,
      'mappingStatus', 'local-catalog-match', 'serviceKey', service_key, 'siteItem', jsonb_build_object(
        'type', 'med-spa', 'service', service_key, 'package', 'single', 'addon', 'none', 'quantity', 1),
      'durationMinutes', 60, 'providerKeys', '["ludimilla","carol"]'::jsonb, 'holdMinutes', 10,
      'priceCents', 14900, 'depositCents', deposit, 'balanceCents', 14900 - deposit))),
  34900, 14900, deposit, now() + start_offset, now() + interval '7 days'
FROM (VALUES ('hydrafacial-piloto-qa', 'HydraFacial', 'hydrafacial', 2500, interval '-1 hour'),
  ('microneedling-synthetic-qa', 'Microneedling', 'microneedling', 3000, interval '1 day'))
  AS data(k, title, service_key, deposit, start_offset);

INSERT INTO public.lltouch_campaign_assets(campaign_id, asset_type, device, position, image_url)
SELECT c.id, 'hero', a.device, 0, 'https://example.invalid/' || a.device || '.jpg'
FROM public.lltouch_campaigns c CROSS JOIN (VALUES ('desktop'), ('mobile')) a(device)
WHERE c.campaign_key IN ('hydrafacial-piloto-qa', 'microneedling-synthetic-qa');

SELECT pg_temp.assert_ok(NOT has_function_privilege('anon',
  'public.lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz)', 'EXECUTE') AND
  NOT has_function_privilege('authenticated',
  'public.lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz)', 'EXECUTE') AND
  NOT has_table_privilege('service_role', 'public.lltouch_cm_commercial_authorization_v1', 'UPDATE') AND
  NOT has_table_privilege('service_role', 'public.lltouch_cm_commercial_audit_v1', 'DELETE'), 'commercial permissions');

SET LOCAL ROLE service_role;
SELECT pg_temp.assert_ok(lltouch_cm_commercial_status_v1('hydrafacial-piloto-qa') @>
  '{"managed":false,"status":"draft","authorization":{"state":"unapproved","active":false,"revision":0}}', 'unapproved default');

UPDATE public.lltouch_campaigns SET marketing = jsonb_set(marketing, '{campaignMeta,mappedReservationAuthorized}', 'true')
WHERE campaign_key = 'hydrafacial-piloto-qa';
SELECT pg_temp.assert_ok(NOT EXISTS (SELECT FROM public.lltouch_campaigns WHERE campaign_key = 'hydrafacial-piloto-qa'
  AND marketing #> '{campaignMeta,mappedReservationAuthorized}' = 'true'::jsonb), 'manual release flag ignored');

SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,0,'publish','qa-admin')$sql$,
  'CM_COMMERCIAL_APPROVAL_REQUIRED');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,0,'approve','qa-admin')$sql$,
  'CM_COMMERCIAL_REVIEW_REQUIRED');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,0,'approve','qa-admin',
  pg_temp.review() - 'availability')$sql$, 'CM_COMMERCIAL_AVAILABILITY_REQUIRED');

UPDATE public.lltouch_campaigns SET deposit_cents = 49 WHERE campaign_key = 'hydrafacial-piloto-qa';
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,0,'approve','qa-admin',pg_temp.review())$sql$,
  'CM_COMMERCIAL_TERMS_INVALID');
UPDATE public.lltouch_campaigns SET deposit_cents = 2500,
  marketing = jsonb_set(marketing, '{campaignMeta,automationPlan,durationMinutes}', '5')
WHERE campaign_key = 'hydrafacial-piloto-qa';
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,0,'approve','qa-admin',pg_temp.review())$sql$,
  'CM_COMMERCIAL_PLAN_INVALID');
UPDATE public.lltouch_campaigns SET marketing = jsonb_set(marketing, '{campaignMeta,automationPlan,durationMinutes}', '60')
WHERE campaign_key = 'hydrafacial-piloto-qa';

SELECT set_config('lltouch_qa.review_token', lltouch_cm_commercial_status_v1('hydrafacial-piloto-qa')->>'reviewToken', true);
UPDATE public.lltouch_campaign_assets a SET image_url = 'https://example.invalid/desktop-before-approval.jpg'
FROM public.lltouch_campaigns c WHERE a.campaign_id = c.id AND c.campaign_key = 'hydrafacial-piloto-qa' AND a.device = 'desktop';
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,0,'approve','qa-admin',
  jsonb_set(pg_temp.review(),'{reviewToken}',to_jsonb(current_setting('lltouch_qa.review_token'))))$sql$,
  'CM_COMMERCIAL_REVIEW_STALE');

SELECT pg_temp.assert_ok(lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,0,'approve','qa-admin',pg_temp.review()) @>
  '{"managed":true,"version":2,"authorization":{"state":"approved","active":false,"version":2,"revision":1,"approvedBy":"qa-admin"}}', 'approve exact draft');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,0,'revoke','qa-admin')$sql$,
  'CM_COMMERCIAL_REVISION_CONFLICT');
SELECT pg_temp.expect_failure($sql$UPDATE public.lltouch_campaigns SET status = 'published', version = 3
  WHERE campaign_key = 'hydrafacial-piloto-qa'$sql$, 'CM_COMMERCIAL_LIFECYCLE_REQUIRED');

UPDATE public.lltouch_campaign_assets a SET image_url = 'https://example.invalid/desktop-new.jpg'
FROM public.lltouch_campaigns c WHERE a.campaign_id = c.id AND c.campaign_key = 'hydrafacial-piloto-qa' AND a.device = 'desktop';
SELECT pg_temp.assert_ok(lltouch_cm_commercial_status_v1('hydrafacial-piloto-qa') @>
  '{"version":2,"authorization":{"state":"invalidated","active":false,"revision":2}}', 'asset invalidates same version');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,2,'publish','qa-admin')$sql$,
  'CM_COMMERCIAL_APPROVAL_REQUIRED');

SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,2,'approve','qa-admin',pg_temp.review());
SELECT pg_temp.assert_ok(lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',2,3,'publish','qa-admin') @>
  '{"status":"published","scheduleState":"active","version":3,"authorization":{"state":"activated","active":true,"version":3,"revision":4}}', 'activation and publication share a transaction');
SELECT pg_temp.assert_ok(EXISTS (SELECT FROM public.lltouch_cm_lead_capture_settings WHERE campaign_key = 'hydrafacial-piloto-qa'
  AND campaign_version = 3 AND enabled), 'capture enabled for published version');
SELECT pg_temp.assert_ok(lltouch_cm_commercial_submit_v1('hydrafacial-piloto-qa',3,'77093673-e401-4d84-a1aa-adc0e38691b6',
  'Synthetic Contact','contact@example.invalid','+12025550123',true,false) @> '{"ok":true,"idempotent":false}', 'active capture');
SELECT pg_temp.assert_ok(lltouch_cm_commercial_submit_v1('hydrafacial-piloto-qa',3,'77093673-e401-4d84-a1aa-adc0e38691b6',
  'Synthetic Contact','contact@example.invalid','+12025550123',true,false) @> '{"ok":true,"idempotent":true}', 'idempotent capture');

SELECT lltouch_cm_commercial_lifecycle_v1('microneedling-synthetic-qa',2,0,'approve','qa-admin',pg_temp.review('microneedling-synthetic-qa'));
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('microneedling-synthetic-qa',2,1,'schedule','qa-admin',
  '{}'::jsonb, (SELECT offer_starts_at FROM public.lltouch_campaigns WHERE campaign_key = 'microneedling-synthetic-qa'))$sql$,
  'CM_COMMERCIAL_ANOTHER_PUBLISHED');
SELECT pg_temp.assert_ok(lltouch_cm_commercial_status_v1('microneedling-synthetic-qa') @>
  '{"status":"draft","authorization":{"revision":1,"state":"approved"}}', 'failed publication retains approval');

SELECT pg_temp.assert_ok(lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',3,4,'revoke','qa-admin') @>
  '{"status":"published","authorization":{"state":"revoked","active":false,"revision":5}}', 'revocation closes commercial actions');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_lead_capture_configure('hydrafacial-piloto-qa',3,true)$sql$,
  'CM_COMMERCIAL_CAPTURE_INACTIVE');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_lead_capture_submit('hydrafacial-piloto-qa',3,'77093673-e401-4d84-a1aa-adc0e38691b7',
  'Synthetic Contact','contact@example.invalid','+12025550123',true,false)$sql$, 'CM_COMMERCIAL_CAPTURE_INACTIVE');
SELECT pg_temp.assert_ok(NOT EXISTS (SELECT FROM public.lltouch_cm_lead_capture_settings
  WHERE campaign_key = 'hydrafacial-piloto-qa' AND enabled), 'revocation disables capture');
SELECT pg_temp.assert_ok(lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',3,5,'pause','qa-admin') @>
  '{"status":"paused","authorization":{"active":false,"revision":6},"version":4}', 'pausing advances campaign version');
SELECT pg_temp.assert_ok(lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',4,6,'return_draft','qa-admin') @>
  '{"status":"draft","version":5,"authorization":{"state":"invalidated","revision":7}}', 'return to editable draft');
SELECT lltouch_cm_commercial_lifecycle_v1('hydrafacial-piloto-qa',5,7,'approve','qa-admin',pg_temp.review());
UPDATE public.lltouch_campaigns SET version = version + 1 WHERE campaign_key = 'hydrafacial-piloto-qa';
SELECT pg_temp.assert_ok(lltouch_cm_commercial_status_v1('hydrafacial-piloto-qa') @>
  '{"version":6,"authorization":{"state":"invalidated","active":false,"revision":9}}', 'a new campaign version invalidates approval');

SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('microneedling-synthetic-qa',2,1,'publish','qa-admin')$sql$,
  'CM_COMMERCIAL_WINDOW_INVALID');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('microneedling-synthetic-qa',2,1,'schedule','qa-admin',
  '{}'::jsonb, now() + interval '2 days')$sql$, 'CM_COMMERCIAL_WINDOW_INVALID');
SELECT pg_temp.assert_ok(lltouch_cm_commercial_lifecycle_v1('microneedling-synthetic-qa',2,1,'schedule','qa-admin',
  '{}'::jsonb, (SELECT offer_starts_at FROM public.lltouch_campaigns WHERE campaign_key = 'microneedling-synthetic-qa')) @>
  '{"status":"published","scheduleState":"scheduled","version":3,"authorization":{"state":"activated","active":false}}', 'future scheduled campaign with non-pilot deposit');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_submit_v1('microneedling-synthetic-qa',3,'77093673-e401-4d84-a1aa-adc0e38691b8',
  'Synthetic Contact','contact@example.invalid','+12025550123',true,false)$sql$, 'CM_COMMERCIAL_CAPTURE_INACTIVE');
SELECT pg_temp.assert_ok(lltouch_cm_commercial_lifecycle_v1('microneedling-synthetic-qa',3,2,'end','qa-admin') @>
  '{"status":"paused","version":4,"authorization":{"state":"ended","active":false,"revision":3}}', 'end closes a scheduled campaign');
SELECT pg_temp.expect_failure($sql$SELECT lltouch_cm_commercial_lifecycle_v1('microneedling-synthetic-qa',4,3,'return_draft','qa-admin')$sql$,
  'CM_COMMERCIAL_STATE_CONFLICT');
RESET ROLE;

SELECT pg_temp.assert_ok(EXISTS (SELECT FROM public.lltouch_cm_commercial_audit_v1 a JOIN public.lltouch_campaigns c
  ON c.id = a.campaign_id WHERE c.campaign_key = 'hydrafacial-piloto-qa' AND a.action = 'publish'
  AND a.actor = 'qa-admin' AND a.from_version = 2 AND a.to_version = 3), 'persisted audited activation actor and versions');
SELECT pg_temp.assert_ok(EXISTS (SELECT FROM public.lltouch_cm_commercial_audit_v1 a JOIN public.lltouch_campaigns c
  ON c.id = a.campaign_id WHERE c.campaign_key = 'hydrafacial-piloto-qa' AND a.action = 'assets_changed'
  AND a.actor = 'database' AND a.from_version = 2 AND a.to_version = 2), 'persisted audited asset invalidation');
ROLLBACK;
\echo Commercial authorization assertions passed
