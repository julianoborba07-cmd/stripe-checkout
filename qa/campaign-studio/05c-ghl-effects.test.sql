\set ON_ERROR_STOP on
BEGIN;
DO $local$
BEGIN
  IF current_database() <> 'lltouch_crm_qa' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Use the isolated CRM test database over its Unix socket';
  END IF;
END;
$local$;

CREATE FUNCTION pg_temp.assert_ok(result boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF result IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
END;
$$;

SELECT pg_temp.assert_ok(NOT has_function_privilege('anon',
  'public.lltouch_cm_commercial_ghl_begin_effect_v1(text,integer,uuid,uuid,text,text)', 'EXECUTE') AND
  NOT has_function_privilege('authenticated',
  'public.lltouch_cm_commercial_ghl_begin_effect_v1(text,integer,uuid,uuid,text,text)', 'EXECUTE') AND
  has_function_privilege('service_role',
  'public.lltouch_cm_commercial_ghl_begin_effect_v1(text,integer,uuid,uuid,text,text)', 'EXECUTE'), 'effect RPC permissions');

INSERT INTO public.lltouch_campaigns(campaign_key,version,status,site_item,service_title,marketing,
  regular_price_cents,price_cents,deposit_cents,offer_starts_at,offer_ends_at)
VALUES ('synthetic-crm-qa',2,'draft','{"type":"manual","requiresVagaroMapping":true}','HydraFacial',
  '{"headline":"Synthetic offer","description":"Reviewed fixture for this test.","campaignMeta":{"automationPlan":
   {"schemaVersion":1,"mappingStatus":"local-catalog-match","serviceKey":"hydrafacial","siteItem":
    {"type":"med-spa","service":"hydrafacial","package":"single","addon":"none","quantity":1},
    "durationMinutes":60,"providerKeys":["ludimilla","carol"],"holdMinutes":10,"priceCents":14900,
    "depositCents":2500,"balanceCents":12400}}}',34900,14900,2500,now()-interval '1 hour',now()+interval '7 days');

INSERT INTO public.lltouch_campaign_assets(campaign_id,asset_type,device,position,image_url)
SELECT c.id,'hero',asset.device,0,'https://example.invalid/'||asset.device||'.jpg'
FROM public.lltouch_campaigns c CROSS JOIN (VALUES ('desktop'),('mobile')) asset(device)
WHERE c.campaign_key='synthetic-crm-qa';

SET LOCAL ROLE service_role;
SELECT pg_temp.assert_ok(NOT lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',2,
  '11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','none','upsert_started'),
  'draft has no CRM permit');

SELECT lltouch_cm_commercial_lifecycle_v1('synthetic-crm-qa',2,0,'approve','synthetic-operator',
  jsonb_build_object('reviewToken',public.lltouch_cm_commercial_status_v1('synthetic-crm-qa')->>'reviewToken',
    'pricingVerified',true,'clinicalCopyReviewed',true,'imagesReviewed',true,
    'publicVisibilityAccepted',true,'availability',jsonb_build_object('date',current_date+2,
      'checkedAt',clock_timestamp(),'providers','["ludimilla","carol"]'::jsonb,
      'sources','["Vagaro","Google Calendar","Supabase"]'::jsonb,'slots',3)));
SELECT lltouch_cm_commercial_lifecycle_v1('synthetic-crm-qa',2,1,'publish','synthetic-operator');
SELECT lltouch_cm_commercial_submit_v1('synthetic-crm-qa',3,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Synthetic CRM Contact','crm@example.invalid','+12025550123',true,false);

INSERT INTO public.lltouch_cm_lead_outbox(lead_id,campaign_id,campaign_key,campaign_version,state,external_step,
  lease_token,lease_expires_at)
SELECT id,campaign_id,campaign_key,campaign_version,'sending','none',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now()+interval '10 minutes'
FROM public.lltouch_cm_leads WHERE campaign_key='synthetic-crm-qa';

SELECT pg_temp.assert_ok(l.sms_marketing_consent=false AND l.contact_consent=true,
  'contact synchronization authorization is separate from SMS consent')
FROM public.lltouch_cm_leads l WHERE campaign_key='synthetic-crm-qa';

SELECT pg_temp.assert_ok(NOT lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',2,
   l.id,o.lease_token,'none','upsert_started') AND
  NOT lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',3,
   l.id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','none','upsert_started') AND
  NOT lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',3,
   l.id,o.lease_token,'none','upsert_recorded'), 'stale version, foreign lease and invalid transition blocked')
FROM public.lltouch_cm_leads l JOIN public.lltouch_cm_lead_outbox o ON l.id=o.lead_id
WHERE l.campaign_key='synthetic-crm-qa';

UPDATE public.lltouch_cm_lead_outbox SET campaign_key='synthetic-unrelated-qa' WHERE campaign_key='synthetic-crm-qa';
SELECT pg_temp.assert_ok(NOT lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',3,
  lead_id,lease_token,'none','upsert_started'), 'outbox for a different campaign cannot authorize an effect')
FROM public.lltouch_cm_lead_outbox WHERE campaign_key='synthetic-unrelated-qa';
UPDATE public.lltouch_cm_lead_outbox SET campaign_key='synthetic-crm-qa',reconciliation_required=true
WHERE campaign_key='synthetic-unrelated-qa';
SELECT pg_temp.assert_ok(NOT lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',3,
  lead_id,lease_token,'none','upsert_started'), 'quarantine cannot authorize an effect')
FROM public.lltouch_cm_lead_outbox WHERE campaign_key='synthetic-crm-qa';
UPDATE public.lltouch_cm_lead_outbox SET reconciliation_required=false WHERE campaign_key='synthetic-crm-qa';

RESET ROLE;
REVOKE UPDATE ON public.lltouch_cm_leads, public.lltouch_cm_lead_outbox FROM service_role;
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_ok(lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',3,
  lead_id,lease_token,'none','upsert_started'), 'matching permit requires no direct table update grants')
FROM public.lltouch_cm_lead_outbox WHERE campaign_key='synthetic-crm-qa';
SELECT pg_temp.assert_ok(NOT lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',3,
  lead_id,lease_token,'none','upsert_started'), 'repeat cannot restart a checkpointed effect')
FROM public.lltouch_cm_lead_outbox WHERE campaign_key='synthetic-crm-qa';
RESET ROLE;
GRANT UPDATE ON public.lltouch_cm_leads, public.lltouch_cm_lead_outbox TO service_role;
SET LOCAL ROLE service_role;

SELECT lltouch_cm_commercial_lifecycle_v1('synthetic-crm-qa',3,2,'revoke','synthetic-operator');
SELECT pg_temp.assert_ok(lltouch_cm_ghl_effect_checkpoint(lead_id,lease_token,'upsert_started','upsert_recorded'),
  'a prior authorized effect can still be acknowledged after revocation')
FROM public.lltouch_cm_lead_outbox WHERE campaign_key='synthetic-crm-qa';
SELECT pg_temp.assert_ok(NOT lltouch_cm_commercial_ghl_begin_effect_v1('synthetic-crm-qa',3,
  lead_id,lease_token,'upsert_recorded','lead_tag_started'), 'no distinct effect can begin after revocation')
FROM public.lltouch_cm_lead_outbox WHERE campaign_key='synthetic-crm-qa';

ROLLBACK;
\echo Commercial GHL checkpoint assertions passed (legacy effect RPC stubbed)
