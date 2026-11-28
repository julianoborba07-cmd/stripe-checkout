-- LL Touch Campaign Studio FINAL 03 | checkpoint 027bf70
-- PREVIEW/QA ONLY. No data mutation on installation; no sender or gate activation.
BEGIN;

-- Do not silently replace an implementation installed since the metadata export.
DO $check$
BEGIN
  IF to_regprocedure('public.lltouch_cm_recovery_seed_mapped_v1(text,integer)') IS NOT NULL
     OR to_regprocedure('public.lltouch_cm_recovery_reserve_mapped_v1(uuid,uuid,integer,uuid)') IS NOT NULL
     OR to_regprocedure('public.lltouch_cm_recovery_resolve_mapped_v1(uuid,uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public.lltouch_cm_recovery_phone_mapped_v1(text)') IS NOT NULL
  THEN RAISE EXCEPTION 'FINAL03_RPC_ALREADY_EXISTS_REVIEW_FIRST'; END IF;
END $check$;

CREATE FUNCTION public.lltouch_cm_recovery_seed_mapped_v1(p_key text,p_version integer)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE c public.lltouch_campaigns%ROWTYPE; n integer; v_now timestamptz;
BEGIN
  IF p_key IS NULL OR p_version IS NULL OR p_version<1 THEN RETURN 0; END IF;
  SELECT * INTO c FROM public.lltouch_campaigns WHERE campaign_key=p_key FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_now:=clock_timestamp();
  IF c.version IS DISTINCT FROM p_version OR c.status IS DISTINCT FROM 'published'
    OR c.offer_starts_at IS NULL OR c.offer_ends_at IS NULL
    OR v_now<c.offer_starts_at OR v_now>=c.offer_ends_at
    OR (c.marketing::jsonb #> '{campaignMeta,mappedRecoveryPlanningAuthorized}') IS DISTINCT FROM 'true'::jsonb
    OR NOT EXISTS (SELECT 1 FROM public.lltouch_cm_lead_capture_settings s WHERE s.campaign_id=c.id
      AND s.campaign_key=c.campaign_key AND s.campaign_version=c.version AND s.enabled IS TRUE)
  THEN RETURN 0; END IF;
  INSERT INTO public.lltouch_cm_recovery_jobs(lead_id,campaign_id,campaign_key,campaign_version,due_at)
  SELECT l.id,c.id,c.campaign_key,c.version,l.created_at+interval '10 minutes'
  FROM public.lltouch_cm_leads l
  WHERE l.campaign_id=c.id AND l.campaign_key=c.campaign_key AND l.campaign_version=c.version
    AND l.contact_consent IS TRUE AND l.sms_marketing_consent IS TRUE
    AND l.created_at>=c.offer_starts_at AND l.created_at<=v_now
    AND NOT EXISTS (SELECT 1 FROM public.lltouch_cm_recovery_jobs j WHERE j.lead_id=l.id)
  ORDER BY l.created_at,l.id LIMIT 50
  ON CONFLICT (lead_id) DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $fn$;

-- Canonical US/NANP destination only; ambiguous/non-US phone is blocked for review.
CREATE FUNCTION public.lltouch_cm_recovery_phone_mapped_v1(p_phone text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE raw text:=btrim(p_phone); digits text;
BEGIN
  IF raw !~ '^\+?[0-9(). -]+$' THEN RETURN NULL; END IF;
  digits:=regexp_replace(raw,'[^0-9]','','g');
  IF raw LIKE '+%' AND digits !~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$' THEN RETURN NULL; END IF;
  IF digits ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' THEN digits:='1'||digits; END IF;
  IF digits !~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$' THEN RETURN NULL; END IF;
  RETURN '+'||digits;
END $fn$;

-- Atomic ledger claim only. Does not create eligibility, send, or call GHL.
-- Requires a separately verified READY job; current audit never produces one.
CREATE FUNCTION public.lltouch_cm_recovery_reserve_mapped_v1(
  p_lead uuid,p_campaign uuid,p_version integer,p_message uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE c public.lltouch_campaigns%ROWTYPE; l public.lltouch_cm_leads%ROWTYPE;
  j public.lltouch_cm_recovery_jobs%ROWTYPE; v_now timestamptz; v_phone text; v_key text; v_id uuid;
BEGIN
  IF p_lead IS NULL OR p_campaign IS NULL OR p_version IS NULL OR p_message IS NULL OR p_version<1
  THEN RETURN jsonb_build_object('status','blocked','reason','INVALID_INPUT'); END IF;
  -- Same lock order as the existing message approval RPC (campaign first).
  SELECT * INTO c FROM public.lltouch_campaigns WHERE id=p_campaign FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','CAMPAIGN_MISSING'); END IF;
  SELECT * INTO l FROM public.lltouch_cm_leads WHERE id=p_lead FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','LEAD_MISSING'); END IF;
  SELECT * INTO j FROM public.lltouch_cm_recovery_jobs WHERE lead_id=p_lead FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','JOB_MISSING'); END IF;
  v_now:=clock_timestamp();
  IF c.version IS DISTINCT FROM p_version OR c.status IS DISTINCT FROM 'published'
    OR c.offer_starts_at IS NULL OR c.offer_ends_at IS NULL OR v_now<c.offer_starts_at OR v_now>=c.offer_ends_at
    OR l.campaign_id IS DISTINCT FROM c.id OR l.campaign_key IS DISTINCT FROM c.campaign_key
    OR l.campaign_version IS DISTINCT FROM p_version OR l.created_at<c.offer_starts_at
    OR l.contact_consent IS DISTINCT FROM true OR l.sms_marketing_consent IS DISTINCT FROM true
    OR j.campaign_id IS DISTINCT FROM c.id OR j.campaign_key IS DISTINCT FROM c.campaign_key
    OR j.campaign_version IS DISTINCT FROM p_version OR j.state IS DISTINCT FROM 'ready'
    OR j.due_at>v_now OR j.due_at<l.created_at+interval '10 minutes'
    OR j.message_version_id IS DISTINCT FROM p_message
    OR j.payment_check IS DISTINCT FROM 'no_paid_deposit_verified'
    OR j.sms_optout_check IS DISTINCT FROM 'clear'
    OR j.payment_checked_at IS NULL OR j.sms_optout_checked_at IS NULL
    OR j.payment_checked_at NOT BETWEEN v_now-interval '60 seconds' AND v_now
    OR j.sms_optout_checked_at NOT BETWEEN v_now-interval '60 seconds' AND v_now
    OR NOT EXISTS (SELECT 1 FROM public.lltouch_cm_lead_capture_settings s WHERE s.campaign_id=c.id
      AND s.campaign_key=c.campaign_key AND s.campaign_version=c.version AND s.enabled IS TRUE)
    OR NOT EXISTS (SELECT 1 FROM public.lltouch_cm_recovery_message_approvals a
      WHERE a.campaign_id=c.id AND a.campaign_version=c.version AND a.message_version_id=p_message)
    OR NOT EXISTS (SELECT 1 FROM public.lltouch_cm_lead_outbox o WHERE o.lead_id=l.id
      AND o.campaign_key=c.campaign_key AND o.state='sent' AND o.external_step='completed'
      AND o.reconciliation_required IS FALSE AND NULLIF(btrim(o.ghl_contact_id::text),'') IS NOT NULL)
  THEN RETURN jsonb_build_object('status','blocked','reason','NOT_READY_OR_STALE'); END IF;
  v_phone:=public.lltouch_cm_recovery_phone_mapped_v1(l.customer_phone);
  IF v_phone IS NULL THEN RETURN jsonb_build_object('status','blocked','reason','RECIPIENT_UNKNOWN'); END IF;
  -- Also inspect old ledger entries by phone in case prior hash conventions differ.
  IF EXISTS (SELECT 1 FROM public.lltouch_cm_recovery_delivery_attempts a
    JOIN public.lltouch_cm_leads oldlead ON oldlead.id=a.lead_id
    WHERE a.campaign_id=c.id AND a.campaign_version=c.version
      AND (a.lead_id=l.id OR public.lltouch_cm_recovery_phone_mapped_v1(oldlead.customer_phone)=v_phone))
  THEN RETURN jsonb_build_object('status','blocked','reason','ALREADY_RESERVED'); END IF;
  v_key:=encode(sha256(convert_to('sms:v1:'||v_phone,'UTF8')),'hex');
  INSERT INTO public.lltouch_cm_recovery_delivery_attempts(lead_id,campaign_id,campaign_version,recipient_dedupe_key)
    VALUES(l.id,c.id,c.version,v_key) ON CONFLICT DO NOTHING RETURNING idempotency_key INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('status','blocked','reason','ALREADY_RESERVED'); END IF;
  UPDATE public.lltouch_cm_recovery_jobs SET state='reserved',updated_at=clock_timestamp()
    WHERE lead_id=l.id AND state='ready';
  IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_CLAIM_STATE_CHANGED'; END IF;
  RETURN jsonb_build_object('status','reserved','idempotencyKey',v_id,'dispatchPerformed',false);
END $fn$;

-- Resolve a reservation once; no retry or re-arm after unknown provider outcome.
-- Confirmed means a verified provider acceptance, not proof of handset delivery.
CREATE FUNCTION public.lltouch_cm_recovery_resolve_mapped_v1(
  p_lead uuid,p_idempotency uuid,p_outcome text,p_provider_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE j public.lltouch_cm_recovery_jobs%ROWTYPE;
BEGIN
  IF p_lead IS NULL OR p_idempotency IS NULL OR p_outcome IS NULL
    OR p_outcome NOT IN ('confirmed','uncertain')
    OR (p_outcome='confirmed' AND (p_provider_reference IS NULL OR p_provider_reference !~ '^[A-Za-z0-9._:-]{6,150}$'))
    OR (p_outcome='uncertain' AND p_provider_reference IS NOT NULL)
  THEN RETURN jsonb_build_object('status','blocked','reason','INVALID_RESOLUTION'); END IF;
  SELECT * INTO j FROM public.lltouch_cm_recovery_jobs WHERE lead_id=p_lead FOR UPDATE;
  IF NOT FOUND OR j.state IS DISTINCT FROM 'reserved' THEN
    RETURN jsonb_build_object('status','blocked','reason','NO_OPEN_RESERVATION'); END IF;
  UPDATE public.lltouch_cm_recovery_delivery_attempts
    SET state=p_outcome,resolved_at=clock_timestamp(),provider_reference=p_provider_reference
    WHERE lead_id=p_lead AND idempotency_key=p_idempotency AND state='reserved';
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','RESERVATION_MISMATCH'); END IF;
  UPDATE public.lltouch_cm_recovery_jobs SET state=CASE WHEN p_outcome='confirmed' THEN 'sent' ELSE 'uncertain' END,
    updated_at=clock_timestamp() WHERE lead_id=p_lead AND state='reserved';
  IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_RESOLUTION_STATE_CHANGED'; END IF;
  RETURN jsonb_build_object('status',p_outcome,'dispatchPerformed',false);
END $fn$;

REVOKE ALL ON FUNCTION public.lltouch_cm_recovery_seed_mapped_v1(text,integer),
  public.lltouch_cm_recovery_phone_mapped_v1(text),
  public.lltouch_cm_recovery_reserve_mapped_v1(uuid,uuid,integer,uuid),
  public.lltouch_cm_recovery_resolve_mapped_v1(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lltouch_cm_recovery_seed_mapped_v1(text,integer),
  public.lltouch_cm_recovery_phone_mapped_v1(text),
  public.lltouch_cm_recovery_reserve_mapped_v1(uuid,uuid,integer,uuid),
  public.lltouch_cm_recovery_resolve_mapped_v1(uuid,uuid,text,text) TO service_role;
COMMIT;
