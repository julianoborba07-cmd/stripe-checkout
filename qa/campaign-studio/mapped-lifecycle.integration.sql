-- Run against the disposable PostgreSQL fixture after 05a and 05c-01 through 05c-03.
BEGIN;
DO $fixture$
BEGIN
  IF current_database() !~ '^lltouch_mapped[a-z]*_qa$' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Use a disposable mapped test database on a local Unix socket';
  END IF;
END
$fixture$;

-- A granted but incompatible overload is not a valid authoring dependency.
CREATE FUNCTION public.lltouch_cm_save_webflow_ai_draft() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
REVOKE EXECUTE ON FUNCTION public.lltouch_cm_save_webflow_ai_draft() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lltouch_cm_save_webflow_ai_draft() TO service_role;

CREATE FUNCTION public.lltouch_cm_mapped_issue_bind_v1(p_snapshot uuid,p_hold uuid,p_session varchar)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
REVOKE EXECUTE ON FUNCTION public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,varchar) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,varchar) TO service_role;
DO $overload$
BEGIN
  IF public.lltouch_cm_commercial_dependencies_v1()->'missing' IS DISTINCT FROM '["authoring","crm","stripe"]'::jsonb THEN
    RAISE EXCEPTION 'Readiness failed to reject incompatible or ambiguous overloads';
  END IF;
END
$overload$;
DROP FUNCTION public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,varchar);
SET LOCAL ROLE service_role;

DO $test$
DECLARE
  key constant text := 'hydrafacial-piloto-qa';
  provider constant text := 'synthetic-qa-provider';
  service constant text := 'synthetic-qa-service';
  session_one constant text := 'cs_live_synthetic_qa_00001';
  session_two constant text := 'cs_live_synthetic_qa_00002';
  event_one constant text := 'evt_synthetic_qa_00001';
  event_two constant text := 'evt_synthetic_qa_00002';
  nonce_one uuid := gen_random_uuid();
  nonce_two uuid := gen_random_uuid();
  lease uuid := gen_random_uuid();
  campaign_id uuid;
  lead_one uuid;
  lead_two uuid;
  hold_one uuid;
  hold_two uuid;
  snapshot_one uuid;
  snapshot_two uuid;
  appointment_day date;
  appointment_start timestamptz;
  result jsonb;
BEGIN
  result := public.lltouch_cm_commercial_dependencies_v1();
  IF result->'missing' IS DISTINCT FROM '["authoring","crm"]'::jsonb THEN
    RAISE EXCEPTION 'An incomplete legacy fixture was misclassified: %', result;
  END IF;
  INSERT INTO public.lltouch_campaigns(campaign_key,version,status,site_item,service_title,marketing,
    regular_price_cents,price_cents,deposit_cents,offer_starts_at,offer_ends_at)
  VALUES (key,2,'draft','{"type":"manual","requiresVagaroMapping":true}','HydraFacial','{}',34900,14900,5000,
    clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '2 days') ON CONFLICT (campaign_key) DO NOTHING;

  SELECT day::date INTO appointment_day FROM generate_series(
    ((clock_timestamp() AT TIME ZONE 'America/New_York')::date + 2)::timestamp,
    ((clock_timestamp() AT TIME ZONE 'America/New_York')::date + 4)::timestamp, interval '1 day'
  ) AS day WHERE extract(isodow FROM day) <> 7 ORDER BY day LIMIT 1;
  appointment_start := (appointment_day + time '10:00') AT TIME ZONE 'America/New_York';

  UPDATE public.lltouch_campaigns SET
    service_title='HydraFacial', deposit_cents=5000,
    marketing='{"headline":"Synthetic HydraFacial","description":"Synthetic campaign exclusively for isolated PostgreSQL testing.",
      "campaignMeta":{"bookingMode":"approval-required","releaseMode":"display-only","checkoutReady":false,"bookingReady":false,
        "automationPlan":{"schemaVersion":1,"mappingStatus":"local-catalog-match","serviceKey":"hydrafacial",
          "siteItem":{"type":"med-spa","service":"hydrafacial","package":"single","addon":"none","quantity":1},
          "durationMinutes":75,"providerKeys":["ludimilla","carol"],"priceCents":14900,"depositCents":5000,"balanceCents":9900,"holdMinutes":10}}}'
  WHERE campaign_key=key AND status='draft' AND version=2 RETURNING id INTO STRICT campaign_id;
  INSERT INTO public.lltouch_campaign_assets VALUES
    (campaign_id,'hero','desktop',0,'https://synthetic-assets.invalid/desktop.jpg'),
    (campaign_id,'hero','mobile',0,'https://synthetic-assets.invalid/mobile.jpg');

  PERFORM public.lltouch_cm_commercial_lifecycle_v1(key,2,0,'approve','synthetic-qa-operator',
    jsonb_build_object('reviewToken',public.lltouch_cm_commercial_status_v1(key)->>'reviewToken',
      'pricingVerified',true,'clinicalCopyReviewed',true,'imagesReviewed',true,'publicVisibilityAccepted',true,
      'availability',jsonb_build_object('date',appointment_day,'checkedAt',clock_timestamp(),
        'providers',jsonb_build_array('ludimilla','carol'),'sources',jsonb_build_array('Vagaro','Google Calendar','Supabase'),'slots',2)));
  result := public.lltouch_cm_commercial_lifecycle_v1(key,2,1,'publish','synthetic-qa-operator');
  IF result->'version' IS DISTINCT FROM '3'::jsonb OR result#>'{authorization,active}' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Approved fixture failed publication %', result;
  END IF;

  lead_one := (public.lltouch_cm_commercial_submit_v1(key,3,nonce_one,'Synthetic QA One','one@campaign-qa.invalid','+17815550101',true,false)->>'leadId')::uuid;
  lead_two := (public.lltouch_cm_commercial_submit_v1(key,3,nonce_two,'Synthetic QA Two','two@campaign-qa.invalid','+17815550102',true,false)->>'leadId')::uuid;
  IF lead_one IS NULL OR lead_two IS NULL OR lead_one=lead_two THEN RAISE EXCEPTION 'Lead fixture failed'; END IF;

  result := public.lltouch_cm_mapped_reserve_v1(key,3,lead_one,nonce_one,'ludimilla',provider,service,appointment_start);
  hold_one := (result->>'holdId')::uuid;
  snapshot_one := (result->>'snapshotId')::uuid;
  IF result->'idempotent' IS DISTINCT FROM 'false'::jsonb OR NOT EXISTS (
    SELECT FROM public.lltouch_cm_universal_checkout_snapshots WHERE id=snapshot_one AND deposit_cents=5000
      AND price_cents=14900 AND immutable_terms->'balanceCents'='9900'::jsonb
  ) THEN RAISE EXCEPTION 'Reservation failed to preserve approved amount'; END IF;

  result := public.lltouch_cm_mapped_reserve_v1(key,3,lead_one,nonce_one,'ludimilla',provider,service,appointment_start);
  IF result->'idempotent' IS DISTINCT FROM 'true'::jsonb OR (result->>'holdId')::uuid IS DISTINCT FROM hold_one THEN
    RAISE EXCEPTION 'Same nonce did not reuse the hold';
  END IF;
  BEGIN
    PERFORM public.lltouch_cm_mapped_reserve_v1(key,3,lead_two,nonce_two,'ludimilla',provider,service,appointment_start);
    RAISE EXCEPTION 'Overlapping hold accepted';
  EXCEPTION
    WHEN exclusion_violation THEN NULL;
    WHEN raise_exception THEN
      IF SQLERRM <> 'CM_MAPPED_SLOT_CONFLICT' THEN RAISE; END IF;
  END;

  result := public.lltouch_cm_mapped_issue_begin_v1(hold_one,snapshot_one,nonce_one,lead_one);
  IF result->>'state' IS DISTINCT FROM 'issuing' THEN RAISE EXCEPTION 'Checkout did not start'; END IF;
  PERFORM public.lltouch_cm_mapped_issue_bind_v1(snapshot_one,hold_one,session_one);
  result := public.lltouch_cm_mapped_issue_begin_v1(hold_one,snapshot_one,nonce_one,lead_one);
  IF result->>'sessionId' IS DISTINCT FROM session_one THEN RAISE EXCEPTION 'Checkout retry did not reuse its session'; END IF;

  result := public.lltouch_cm_mapped_issue_event_v1(snapshot_one,hold_one,session_one,event_one,'paid_candidate','TEST_VERIFIED',clock_timestamp());
  IF result->>'action' IS DISTINCT FROM 'paid_candidate' THEN RAISE EXCEPTION 'On-time payment did not reconcile'; END IF;
  result := public.lltouch_cm_mapped_issue_event_v1(snapshot_one,hold_one,session_one,event_one,'review','TEST_REPLAY',NULL);
  IF result->'duplicate' IS DISTINCT FROM 'true'::jsonb OR result->>'action' IS DISTINCT FROM 'paid_candidate' THEN
    RAISE EXCEPTION 'Webhook duplicate changed the stored outcome';
  END IF;

  result := public.lltouch_cm_mapped_booking_claim_v1();
  IF (result#>>'{hold,id}')::uuid IS DISTINCT FROM hold_one THEN RAISE EXCEPTION 'Booking worker did not acquire paid hold'; END IF;
  IF public.lltouch_cm_mapped_booking_claim_v1()->'claimed' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'Duplicate booking claim was available';
  END IF;
  result := public.lltouch_cm_mapped_booking_finish_v1(hold_one,snapshot_one,NULL,'review');
  IF result->'customerConfirmationAuthorized' IS DISTINCT FROM 'false'::jsonb OR EXISTS (
    SELECT FROM public.lltouch_appointments WHERE stripe_session_id=session_one
  ) THEN RAISE EXCEPTION 'Failed booking yielded a customer confirmation or appointment'; END IF;

  result := public.lltouch_cm_mapped_reserve_v1(key,3,lead_two,nonce_two,'ludimilla',provider,service,appointment_start+interval '2 hours');
  hold_two := (result->>'holdId')::uuid;
  snapshot_two := (result->>'snapshotId')::uuid;
  PERFORM public.lltouch_cm_mapped_issue_begin_v1(hold_two,snapshot_two,nonce_two,lead_two);
  PERFORM public.lltouch_cm_mapped_issue_bind_v1(snapshot_two,hold_two,session_two);
  UPDATE public.lltouch_cm_universal_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE id=hold_two;
  IF NOT EXISTS (SELECT FROM public.lltouch_cm_mapped_due_issues_v1() WHERE hold_id=hold_two) THEN
    RAISE EXCEPTION 'Expired checkout was not due for reconciliation';
  END IF;
  result := public.lltouch_cm_mapped_poll_result_v1(snapshot_two,hold_two,session_two,'expiry_candidate','TEST_EXPIRED',NULL);
  IF result->>'action' IS DISTINCT FROM 'expiry_candidate' THEN RAISE EXCEPTION 'Confirmed expiry failed'; END IF;
  result := public.lltouch_cm_mapped_issue_event_v1(snapshot_two,hold_two,session_two,event_two,'paid_candidate','TEST_LATE',clock_timestamp());
  IF result->>'action' IS DISTINCT FROM 'review' OR NOT EXISTS (
    SELECT FROM public.lltouch_cm_universal_holds WHERE id=hold_two AND state='expired'
  ) THEN RAISE EXCEPTION 'Late payment resurrected a released slot'; END IF;

  INSERT INTO public.lltouch_cm_lead_outbox(lead_id,campaign_id,campaign_key,campaign_version,state,external_step,lease_token,lease_expires_at)
  VALUES (lead_one,campaign_id,key,3,'sending','none',lease,clock_timestamp()+interval '1 minute'),
         (lead_two,campaign_id,key,3,'sending','none',lease,clock_timestamp()+interval '1 minute');
  UPDATE public.lltouch_cm_leads SET contact_consent=false WHERE id=lead_two;
  IF public.lltouch_cm_commercial_ghl_begin_effect_v1(key,3,lead_two,lease,'none','upsert_started') IS DISTINCT FROM false OR
     public.lltouch_cm_commercial_ghl_begin_effect_v1(key,3,lead_one,gen_random_uuid(),'none','upsert_started') IS DISTINCT FROM false OR
     public.lltouch_cm_commercial_ghl_begin_effect_v1(key,3,lead_one,lease,'none','upsert_started') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CRM authorization failed for consent or valid lease';
  END IF;
  IF public.lltouch_cm_commercial_ghl_begin_effect_v1(key,3,lead_one,lease,'none','upsert_started') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'CRM checkpoint allowed a duplicate effect';
  END IF;
  UPDATE public.lltouch_cm_lead_outbox SET external_step='upsert_recorded' WHERE lead_id=lead_one;
  PERFORM public.lltouch_cm_commercial_lifecycle_v1(key,3,2,'revoke','synthetic-qa-operator');
  IF public.lltouch_cm_commercial_ghl_begin_effect_v1(key,3,lead_one,lease,'upsert_recorded','lead_tag_started') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'CRM effect started after commercial revocation';
  END IF;

  UPDATE public.lltouch_cm_lead_outbox SET state='sent',ghl_contact_id='synthetic-existing-contact'
  WHERE lead_id IN (lead_one, lead_two);
  IF public.lltouch_cm_commercial_metrics_v1(campaign_id)->'contactsSynced' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'One CRM contact was counted for each lead';
  END IF;
  UPDATE public.lltouch_cm_lead_outbox SET state='failed',reconciliation_required=true WHERE lead_id=lead_one;
  result := public.lltouch_cm_commercial_metrics_v1(campaign_id);
  IF result->'leadsCaptured' IS DISTINCT FROM '2'::jsonb OR
     result->'contactsSynced' IS DISTINCT FROM '1'::jsonb OR
     result->'integrationFailures' IS DISTINCT FROM '1'::jsonb OR
     result->'depositsPaid' IS DISTINCT FROM '1'::jsonb OR result->'conversions' IS DISTINCT FROM '1'::jsonb OR
     result->'expiredReservations' IS DISTINCT FROM '1'::jsonb OR result->'reconciliationPending' IS DISTINCT FROM '3'::jsonb OR
     result->'bookingsConfirmed' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Metrics did not attribute the paid, expired and review states correctly: %', result;
  END IF;

  RAISE NOTICE 'PASS | mapped reservation, overlap, issue, duplicate webhook, booking failure, expiry, late payment, CRM authorization and metrics';
END
$test$;
ROLLBACK;
