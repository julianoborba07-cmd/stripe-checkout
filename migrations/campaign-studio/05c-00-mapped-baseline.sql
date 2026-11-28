-- FINAL 05C | Candidate mapped commercial baseline.
-- Derived from QA installation 05A at e0f4041. The reviewed RPC bodies,
-- reserve correction, role grants and ledger constraints are preserved. Reset
-- inherited default service_role grants before applying each ledger's grant list.
-- Install only on an absent baseline, with application releases stopped.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $catalog_guard$
DECLARE
  present integer;
BEGIN
  SELECT count(*) INTO present
  FROM (
    SELECT to_regprocedure(signature)::oid AS object_id
    FROM unnest(ARRAY[
      'public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz)',
      'public.lltouch_cm_mapped_issue_begin_v1(uuid,uuid,uuid,uuid)',
      'public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,text)',
      'public.lltouch_cm_mapped_issue_event_v1(uuid,uuid,text,text,text,text,timestamptz)',
      'public.lltouch_cm_mapped_due_issues_v1()',
      'public.lltouch_cm_mapped_poll_result_v1(uuid,uuid,text,text,text,timestamptz)',
      'public.lltouch_cm_mapped_booking_claim_v1()',
      'public.lltouch_cm_mapped_booking_finish_v1(uuid,uuid,uuid,text)'
    ]) AS r(signature)
    UNION ALL
    SELECT to_regclass(relation)::oid
    FROM unnest(ARRAY[
      'public.lltouch_cm_mapped_issue_v1',
      'public.lltouch_cm_mapped_event_v1',
      'public.lltouch_cm_mapped_booking_v1'
    ]) AS t(relation)
  ) AS objects
  WHERE object_id IS NOT NULL;

  IF present = 11 THEN RAISE EXCEPTION 'CM_MAPPED_BASELINE_ALREADY_PRESENT_VERIFY'; END IF;
  IF present <> 0 THEN RAISE EXCEPTION 'CM_MAPPED_BASELINE_PARTIAL_INSTALL' USING DETAIL = present || ' of 11 baseline objects present'; END IF;
  IF to_regclass('public.lltouch_campaigns') IS NULL THEN RAISE EXCEPTION 'CM_SCHEMA_MISSING'; END IF;
END
$catalog_guard$;

LOCK TABLE public.lltouch_campaigns IN SHARE MODE;
DO $release_guard$
BEGIN
 IF EXISTS (SELECT 1 FROM public.lltouch_campaigns WHERE status='published'
 OR marketing #> '{campaignMeta,mappedReservationAuthorized}'='true'::jsonb
 OR marketing #> '{campaignMeta,mappedCheckoutAuthorized}'='true'::jsonb) THEN
   RAISE EXCEPTION 'CM_MAPPED_BASELINE_ACTIVE_CAMPAIGN';
 END IF;
END
$release_guard$;

-- Source block base0
DO $guard$
BEGIN
  IF to_regclass('public.lltouch_cm_universal_holds') IS NULL OR
     to_regclass('public.lltouch_cm_universal_checkout_snapshots') IS NULL OR
     to_regclass('public.lltouch_cm_leads') IS NULL OR
     to_regclass('public.lltouch_campaigns') IS NULL OR
     to_regclass('public.lltouch_offer_claims') IS NULL OR
     to_regclass('public.lltouch_appointments') IS NULL THEN
    RAISE EXCEPTION 'CM_SCHEMA_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.lltouch_cm_universal_holds'::regclass AND conname='llt_cm_active_provider_overlap_excl' AND contype='x' AND convalidated) THEN
    RAISE EXCEPTION 'CM_HOLD_EXCLUSION_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.lltouch_cm_universal_checkout_snapshots'::regclass AND tgname='ll_cm_universal_snapshot_immutable_trg' AND tgenabled IN ('O','A')) THEN
    RAISE EXCEPTION 'CM_SNAPSHOT_IMMUTABILITY_MISSING';
  END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'CM_RPC_ALREADY_EXISTS_REVIEW_BEFORE_REAPPLY';
  END IF;
END
$guard$;

-- Source block base1
CREATE FUNCTION public.lltouch_cm_mapped_reserve_v1(
  p_campaign_key text,
  p_campaign_version integer,
  p_lead_id uuid,
  p_client_nonce uuid,
  p_provider_key text,
  p_provider_id text,
  p_service_id text,
  p_start timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  c public.lltouch_campaigns%ROWTYPE;
  l public.lltouch_cm_leads%ROWTYPE;
  h public.lltouch_cm_universal_holds%ROWTYPE;
  s public.lltouch_cm_universal_checkout_snapshots%ROWTYPE;
  plan jsonb;
  meta jsonb;
  quote jsonb;
  duration_min integer;
  finish timestamptz;
  local_start timestamp;
  local_finish timestamp;
  moment timestamptz;
  expires timestamptz;
  hold_id uuid;
  snapshot_id uuid;
  -- Compatibility marker for legacy non-null area columns; not a treatment area.
  area_marker constant text := 'service-only';
BEGIN
  IF p_campaign_key IS NULL OR p_campaign_key !~ '^[a-z0-9][a-z0-9-]{3,95}$' OR
     p_campaign_version IS NULL OR p_campaign_version < 1 OR p_lead_id IS NULL OR p_client_nonce IS NULL OR
     p_provider_key IS NULL OR p_provider_key NOT IN ('ludimilla','carol') OR
     p_provider_id IS NULL OR length(btrim(p_provider_id)) NOT BETWEEN 1 AND 200 OR
     p_service_id IS NULL OR length(btrim(p_service_id)) NOT BETWEEN 1 AND 200 OR
     p_start IS NULL OR NOT isfinite(p_start) THEN
    RAISE EXCEPTION 'CM_MAPPED_INPUT_INVALID';
  END IF;
  -- Same lock namespace as legacy offer plus universal provider lock. Other booking
  -- writers must also be coordinated before commercial release; this alone is not enough.
  PERFORM pg_advisory_xact_lock(5520261105);
  PERFORM pg_advisory_xact_lock(hashtext('llt_cm_hold:'||p_provider_key));
  SELECT * INTO c FROM public.lltouch_campaigns WHERE campaign_key=p_campaign_key FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CM_MAPPED_CAMPAIGN_NOT_FOUND'; END IF;
  meta := c.marketing->'campaignMeta';
  plan := meta->'automationPlan';
  moment := clock_timestamp();
  -- Independent opt-in, absent in the current authoring flow. Do not set it manually.
  IF meta->'mappedReservationAuthorized' IS DISTINCT FROM 'true'::jsonb OR
     c.status IS DISTINCT FROM 'published' OR c.version IS DISTINCT FROM p_campaign_version OR
     meta->>'releaseMode' IS DISTINCT FROM 'display-only' OR
     meta->'checkoutReady' IS DISTINCT FROM 'false'::jsonb OR
     meta->'bookingReady' IS DISTINCT FROM 'false'::jsonb OR
     moment<c.offer_starts_at OR moment+interval '10 minutes'>c.offer_ends_at OR
     c.currency<>'usd' OR c.timezone<>'America/New_York' OR c.hold_minutes<>10 OR
     c.price_cents<=0 OR c.deposit_cents<=0 OR c.deposit_cents>c.price_cents OR c.regular_price_cents<c.price_cents THEN
    RAISE EXCEPTION 'CM_MAPPED_RESERVATION_DISABLED';
  END IF;
  IF plan->>'mappingStatus' IS DISTINCT FROM 'local-catalog-match' OR
     plan->>'serviceKey' IS NULL OR plan->>'serviceKey' NOT IN ('hydrafacial','microneedling','llumigold','ll-signature','classic-deluxe','diamond-glow','dermaplaning') OR
     plan->'siteItem'->>'type' IS NULL OR plan->'siteItem'->>'type' NOT IN ('med-spa','facial') OR
     plan->'siteItem'->>'service' IS DISTINCT FROM plan->>'serviceKey' OR
     plan->'siteItem'->>'package' IS DISTINCT FROM 'single' OR
     plan->'siteItem'->>'addon' IS DISTINCT FROM 'none' OR
     plan->'siteItem'->>'quantity' IS DISTINCT FROM '1' OR
     plan->>'durationMinutes' IS NULL OR plan->>'durationMinutes' !~ '^[0-9]{1,3}$' OR
     plan->'providerKeys' IS DISTINCT FROM '["ludimilla","carol"]'::jsonb OR
     plan->>'priceCents' IS DISTINCT FROM c.price_cents::text OR
     plan->>'depositCents' IS DISTINCT FROM c.deposit_cents::text OR
     plan->>'holdMinutes' IS DISTINCT FROM c.hold_minutes::text THEN
    RAISE EXCEPTION 'CM_MAPPED_PLAN_INVALID';
  END IF;
  duration_min := (plan->>'durationMinutes')::integer;
  IF duration_min NOT BETWEEN 10 AND 240 THEN RAISE EXCEPTION 'CM_MAPPED_DURATION_INVALID'; END IF;
  finish := p_start + make_interval(mins=>duration_min);
  local_start := p_start AT TIME ZONE 'America/New_York';
  local_finish := finish AT TIME ZONE 'America/New_York';
  IF p_start<=moment+interval '10 minutes' OR
     local_start::date>(moment AT TIME ZONE 'America/New_York')::date+27 OR
     extract(isodow FROM local_start)=7 OR
     local_start::date<>local_finish::date OR local_start::time<time '09:00' OR local_finish::time>time '18:00' OR
     extract(second FROM local_start)<>0 THEN
    RAISE EXCEPTION 'CM_MAPPED_SLOT_INVALID';
  END IF;
  SELECT * INTO l FROM public.lltouch_cm_leads WHERE id=p_lead_id AND campaign_id=c.id AND client_nonce=p_client_nonce FOR SHARE;
  IF NOT FOUND OR l.campaign_version IS DISTINCT FROM c.version OR l.campaign_key IS DISTINCT FROM c.campaign_key OR l.contact_consent IS DISTINCT FROM true OR
     l.quote_snapshot->>'priceCents' IS DISTINCT FROM c.price_cents::text OR
     l.quote_snapshot->>'regularPriceCents' IS DISTINCT FROM c.regular_price_cents::text OR
     l.quote_snapshot->>'depositCents' IS DISTINCT FROM c.deposit_cents::text OR
     l.quote_snapshot->>'currency' IS DISTINCT FROM c.currency OR
     l.quote_snapshot->>'sourceCampaignVersion' IS DISTINCT FROM c.version::text THEN
    RAISE EXCEPTION 'CM_MAPPED_LEAD_OR_QUOTE_INVALID';
  END IF;
  quote := jsonb_build_object('mode','mapped-service-v1','campaignKey',c.campaign_key,'campaignVersion',c.version,
    'leadId',l.id,'serviceKey',plan->>'serviceKey','serviceName',c.service_title,'siteItem',plan->'siteItem',
    'serviceId',p_service_id,'providerKey',p_provider_key,'providerId',p_provider_id,'sessions',1,'areaKey',NULL,
    'durationMinutes',duration_min,'regularPriceCents',c.regular_price_cents,'priceCents',c.price_cents,
    'depositCents',c.deposit_cents,'balanceCents',c.price_cents-c.deposit_cents,'currency',c.currency,
    'holdMinutes',c.hold_minutes,'appointmentStart',p_start,'appointmentEnd',finish);
  SELECT * INTO h FROM public.lltouch_cm_universal_holds WHERE campaign_id=c.id AND client_nonce=p_client_nonce FOR UPDATE;
  IF FOUND THEN
    IF h.quote_snapshot IS DISTINCT FROM quote OR h.state<>'held' OR h.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'CM_MAPPED_NONCE_CONFLICT_OR_EXPIRED';
    END IF;
    SELECT * INTO s FROM public.lltouch_cm_universal_checkout_snapshots WHERE hold_id=h.id;
    IF NOT FOUND OR s.immutable_terms IS DISTINCT FROM quote THEN RAISE EXCEPTION 'CM_MAPPED_SNAPSHOT_MISSING'; END IF;
    RETURN jsonb_build_object('ok',true,'holdId',h.id,'snapshotId',s.id,'expiresAt',h.expires_at,'idempotent',true,'checkoutReady',false);
  END IF;
  IF EXISTS (SELECT 1 FROM public.lltouch_offer_claims x WHERE x.provider_id=p_provider_id AND x.starts_at<finish AND x.ends_at>p_start AND
       ((x.state='held' AND x.hold_expires_at>clock_timestamp()) OR x.state IN ('checkout','paid','processing','confirmed','review'))) OR
     EXISTS (SELECT 1 FROM public.lltouch_appointments a WHERE a.provider_id=p_provider_id AND a.starts_at<finish AND a.ends_at>p_start AND a.status IN ('pending','confirmed')) THEN
    RAISE EXCEPTION 'CM_MAPPED_SLOT_CONFLICT';
  END IF;
  UPDATE public.lltouch_cm_universal_holds SET state='expired',updated_at=clock_timestamp()
   WHERE provider_key=p_provider_key AND state='held' AND expires_at<=clock_timestamp() AND appointment_start<finish AND appointment_end>p_start;
  expires := clock_timestamp()+interval '10 minutes';
  IF expires>c.offer_ends_at THEN RAISE EXCEPTION 'CM_MAPPED_CAMPAIGN_CLOSING'; END IF;
  INSERT INTO public.lltouch_cm_universal_holds(campaign_id,campaign_key,campaign_version,client_nonce,state,
    customer_name,customer_email,customer_phone,contact_consent,sms_marketing_consent,treatment_area_key,booking_mode,
    provider_key,requested_date,requested_time,appointment_start,appointment_end,quote_snapshot,expires_at)
  VALUES(c.id,c.campaign_key,c.version,p_client_nonce,'held',l.customer_name,l.customer_email,l.customer_phone,true,
    l.sms_marketing_consent,area_marker,'suggested',p_provider_key,local_start::date,local_start::time,p_start,finish,quote,expires)
  RETURNING id INTO hold_id;
  INSERT INTO public.lltouch_cm_universal_checkout_snapshots(hold_id,campaign_id,campaign_key,campaign_version,
    currency,price_cents,deposit_cents,sessions,booking_mode,treatment_area_key,immutable_terms)
  VALUES(hold_id,c.id,c.campaign_key,c.version,c.currency,c.price_cents,c.deposit_cents,1,'suggested',area_marker,quote)
  RETURNING id INTO snapshot_id;
  RETURN jsonb_build_object('ok',true,'holdId',hold_id,'snapshotId',snapshot_id,'expiresAt',expires,'idempotent',false,'checkoutReady',false);
EXCEPTION WHEN exclusion_violation THEN RAISE EXCEPTION 'CM_MAPPED_SLOT_CONFLICT';
WHEN unique_violation THEN RAISE EXCEPTION 'CM_MAPPED_NONCE_CONFLICT';
END
$fn$;

-- Source block base2
REVOKE ALL ON FUNCTION public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;

-- Source block base3
GRANT EXECUTE ON FUNCTION public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz) TO service_role;

-- Source block base4
DO $check$
DECLARE f regprocedure := 'public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz)'::regprocedure;
BEGIN
 IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE') THEN
   RAISE EXCEPTION 'CM_MAPPED_RPC_GRANTS_INVALID';
 END IF;
 IF EXISTS(SELECT 1 FROM public.lltouch_campaigns WHERE marketing #> '{campaignMeta,mappedReservationAuthorized}'='true'::jsonb) THEN
   RAISE EXCEPTION 'CM_MAPPED_GATE_ALREADY_ENABLED';
 END IF;
END
$check$;

-- Source block reservefix
DO $fixreserve$
DECLARE
 f regprocedure := to_regprocedure('public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz)');
 old_body text; new_body text; old_def text; new_def text; old_acl aclitem[]; old_owner oid; old_config text[];
BEGIN
 IF f IS NULL THEN RAISE EXCEPTION 'STOP | RPC base ausente'; END IF;
 IF EXISTS(SELECT 1 FROM public.lltouch_campaigns WHERE marketing #> '{campaignMeta,mappedReservationAuthorized}'='true'::jsonb OR marketing #> '{campaignMeta,mappedCheckoutAuthorized}'='true'::jsonb) THEN
   RAISE EXCEPTION 'STOP | gate comercial habilitado';
 END IF;
 SELECT prosrc,proacl,proowner,proconfig INTO STRICT old_body,old_acl,old_owner,old_config FROM pg_proc WHERE oid=f AND NOT prosecdef;
 IF md5(btrim(old_body,E' \n\r\t')) NOT IN ('754c5b5287dee4c595ca82daa612c852','637e0ea85e63f1343f855fcceedc1c6c') THEN RAISE EXCEPTION 'STOP | definicao da RPC diferente da versao revisada'; END IF;
 new_body:=old_body;
 IF md5(btrim(old_body,E' \n\r\t'))='754c5b5287dee4c595ca82daa612c852' THEN
  new_body:=replace(new_body,$old$  hold_id uuid;$old$,$new$  v_hold_id uuid;$new$);
  new_body:=replace(new_body,$old$  snapshot_id uuid;$old$,$new$  v_snapshot_id uuid;$new$);
  new_body:=replace(new_body,$old$SELECT * INTO s FROM public.lltouch_cm_universal_checkout_snapshots WHERE hold_id=h.id;$old$,$new$SELECT ss.* INTO s FROM public.lltouch_cm_universal_checkout_snapshots AS ss WHERE ss.hold_id=h.id;$new$);
  new_body:=replace(new_body,$old$RETURNING id INTO hold_id;$old$,$new$RETURNING id INTO v_hold_id;$new$);
  new_body:=replace(new_body,$old$VALUES(hold_id,c.id,$old$,$new$VALUES(v_hold_id,c.id,$new$);
  new_body:=replace(new_body,$old$RETURNING id INTO snapshot_id;$old$,$new$RETURNING id INTO v_snapshot_id;$new$);
  new_body:=replace(new_body,$old$'holdId',hold_id,'snapshotId',snapshot_id$old$,$new$'holdId',v_hold_id,'snapshotId',v_snapshot_id$new$);
  IF md5(btrim(new_body,E' \n\r\t'))<>'637e0ea85e63f1343f855fcceedc1c6c' THEN RAISE EXCEPTION 'STOP | corpo corrigido inesperado'; END IF;
  old_def:=pg_get_functiondef(f);
  IF strpos(old_def,old_body)=0 THEN RAISE EXCEPTION 'STOP | corpo nao localizado'; END IF;
  new_def:=replace(old_def,old_body,new_body);
  EXECUTE new_def;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=f AND NOT prosecdef AND proacl IS NOT DISTINCT FROM old_acl AND proowner=old_owner AND proconfig IS NOT DISTINCT FROM old_config AND md5(btrim(prosrc,E' \n\r\t'))='637e0ea85e63f1343f855fcceedc1c6c') OR
    has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE') THEN
  RAISE EXCEPTION 'STOP | verificacao da RPC corrigida falhou';
 END IF;
END $fixreserve$;

-- Source block ddl0
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lltouch_campaigns
     WHERE marketing #> '{campaignMeta,mappedReservationAuthorized}' = 'true'::jsonb
        OR marketing #> '{campaignMeta,mappedCheckoutAuthorized}' = 'true'::jsonb) THEN
    RAISE EXCEPTION 'STOP | gate comercial ja habilitado';
  END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'STOP | RPC base nao instalada neste banco';
  END IF;
  IF to_regclass('public.lltouch_cm_mapped_issue_v1') IS NOT NULL THEN RAISE EXCEPTION 'STOP | tabela candidata ja existe: lltouch_cm_mapped_issue_v1'; END IF;
  IF to_regclass('public.lltouch_cm_mapped_event_v1') IS NOT NULL THEN RAISE EXCEPTION 'STOP | tabela candidata ja existe: lltouch_cm_mapped_event_v1'; END IF;
  IF to_regclass('public.lltouch_cm_mapped_booking_v1') IS NOT NULL THEN RAISE EXCEPTION 'STOP | tabela candidata ja existe: lltouch_cm_mapped_booking_v1'; END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_issue_begin_v1(uuid,uuid,uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'STOP | RPC candidata ja existe: lltouch_cm_mapped_issue_begin_v1'; END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'STOP | RPC candidata ja existe: lltouch_cm_mapped_issue_bind_v1'; END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_issue_event_v1(uuid,uuid,text,text,text,text,timestamptz)') IS NOT NULL THEN RAISE EXCEPTION 'STOP | RPC candidata ja existe: lltouch_cm_mapped_issue_event_v1'; END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_due_issues_v1()') IS NOT NULL THEN RAISE EXCEPTION 'STOP | RPC candidata ja existe: lltouch_cm_mapped_due_issues_v1'; END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_poll_result_v1(uuid,uuid,text,text,text,timestamptz)') IS NOT NULL THEN RAISE EXCEPTION 'STOP | RPC candidata ja existe: lltouch_cm_mapped_poll_result_v1'; END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_booking_claim_v1()') IS NOT NULL THEN RAISE EXCEPTION 'STOP | RPC candidata ja existe: lltouch_cm_mapped_booking_claim_v1'; END IF;
  IF to_regprocedure('public.lltouch_cm_mapped_booking_finish_v1(uuid,uuid,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'STOP | RPC candidata ja existe: lltouch_cm_mapped_booking_finish_v1'; END IF;
END $preflight$;

-- Source block ddl1
-- Candidate only. Review in an isolated database before production. No customer writes on install.

DO $guard$
BEGIN
 IF to_regprocedure('public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz)') IS NULL OR
    NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.lltouch_cm_universal_holds'::regclass AND conname='llt_cm_active_provider_overlap_excl' AND contype='x' AND convalidated) THEN
  RAISE EXCEPTION 'CM_MAPPED_PREREQUISITE_MISSING';
 END IF;
 IF to_regclass('public.lltouch_cm_mapped_issue_v1') IS NOT NULL THEN RAISE EXCEPTION 'CM_MAPPED_ISSUE_ALREADY_EXISTS'; END IF;
END; $guard$;

-- Source block ddl2
CREATE TABLE public.lltouch_cm_mapped_issue_v1 (
 snapshot_id uuid PRIMARY KEY REFERENCES public.lltouch_cm_universal_checkout_snapshots(id) ON DELETE RESTRICT,
 hold_id uuid NOT NULL UNIQUE REFERENCES public.lltouch_cm_universal_holds(id) ON DELETE RESTRICT,
 session_id text UNIQUE CHECK (session_id IS NULL OR session_id ~ '^cs_live_[A-Za-z0-9_]{12,200}$'),
 state text NOT NULL CHECK (state IN ('issuing','bound','paid','expired','review')),
 last_reason text,
 paid_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (state NOT IN ('bound','paid','expired') OR session_id IS NOT NULL),
 CHECK (state <> 'paid' OR paid_at IS NOT NULL)
);

-- Source block ddl3
ALTER TABLE public.lltouch_cm_mapped_issue_v1 ENABLE ROW LEVEL SECURITY;

-- Source block ddl4
REVOKE ALL ON TABLE public.lltouch_cm_mapped_issue_v1 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.lltouch_cm_mapped_issue_v1 FROM service_role;

-- Source block ddl5
GRANT SELECT,INSERT,UPDATE ON TABLE public.lltouch_cm_mapped_issue_v1 TO service_role;

-- Source block ddl6
CREATE TABLE public.lltouch_cm_mapped_event_v1 (
 event_id text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_]{8,200}$'),
 snapshot_id uuid NOT NULL REFERENCES public.lltouch_cm_mapped_issue_v1(snapshot_id) ON DELETE RESTRICT,
 session_id text NOT NULL,
 action text NOT NULL CHECK (action IN ('paid_candidate','expiry_candidate','review','already_reconciled','wait')),
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Source block ddl7
ALTER TABLE public.lltouch_cm_mapped_event_v1 ENABLE ROW LEVEL SECURITY;

-- Source block ddl8
REVOKE ALL ON TABLE public.lltouch_cm_mapped_event_v1 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.lltouch_cm_mapped_event_v1 FROM service_role;

-- Source block ddl9
GRANT SELECT,INSERT ON TABLE public.lltouch_cm_mapped_event_v1 TO service_role;

-- Source block ddl10
-- Lock BEFORE Stripe network call. An uncertain call is deliberately not freed.
CREATE FUNCTION public.lltouch_cm_mapped_issue_begin_v1(p_hold uuid,p_snapshot uuid,p_nonce uuid,p_lead uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE h public.lltouch_cm_universal_holds%ROWTYPE; s public.lltouch_cm_universal_checkout_snapshots%ROWTYPE; c public.lltouch_campaigns%ROWTYPE; i public.lltouch_cm_mapped_issue_v1%ROWTYPE; m jsonb;
BEGIN
 SELECT * INTO h FROM public.lltouch_cm_universal_holds WHERE id=p_hold AND client_nonce=p_nonce FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CM_MAPPED_HOLD_NOT_FOUND'; END IF;
 SELECT * INTO s FROM public.lltouch_cm_universal_checkout_snapshots WHERE id=p_snapshot AND hold_id=h.id;
 IF NOT FOUND OR s.immutable_terms IS DISTINCT FROM h.quote_snapshot OR h.quote_snapshot->>'mode' IS DISTINCT FROM 'mapped-service-v1' OR h.quote_snapshot->>'leadId' IS DISTINCT FROM p_lead::text OR s.campaign_id IS DISTINCT FROM h.campaign_id OR s.campaign_version IS DISTINCT FROM h.campaign_version OR s.campaign_key IS DISTINCT FROM h.campaign_key THEN RAISE EXCEPTION 'CM_MAPPED_SNAPSHOT_INVALID'; END IF;
 SELECT * INTO c FROM public.lltouch_campaigns WHERE id=h.campaign_id FOR SHARE;
 m:=c.marketing->'campaignMeta';
 IF NOT FOUND OR c.version IS DISTINCT FROM h.campaign_version OR c.status IS DISTINCT FROM 'published' OR m->'mappedReservationAuthorized' IS DISTINCT FROM 'true'::jsonb OR m->'mappedCheckoutAuthorized' IS DISTINCT FROM 'true'::jsonb OR m->>'releaseMode' IS DISTINCT FROM 'display-only' OR c.offer_starts_at>clock_timestamp() OR c.offer_ends_at<=clock_timestamp() OR h.expires_at<=clock_timestamp() OR h.appointment_start<=clock_timestamp() THEN RAISE EXCEPTION 'CM_MAPPED_CHECKOUT_GATE_CLOSED'; END IF;
 SELECT * INTO i FROM public.lltouch_cm_mapped_issue_v1 WHERE snapshot_id=s.id FOR UPDATE;
 IF FOUND THEN
  IF i.hold_id IS DISTINCT FROM h.id OR h.state<>'checkout' OR i.state NOT IN ('issuing','bound') OR i.session_id IS DISTINCT FROM h.stripe_session_id THEN RAISE EXCEPTION 'CM_MAPPED_ISSUE_CONFLICT'; END IF;
  RETURN jsonb_build_object('ok',true,'state',i.state,'sessionId',i.session_id,'hold',to_jsonb(h),'snapshot',to_jsonb(s));
 END IF;
 IF h.state<>'held' OR h.stripe_session_id IS NOT NULL THEN RAISE EXCEPTION 'CM_MAPPED_HOLD_NOT_ISSUABLE'; END IF;
 INSERT INTO public.lltouch_cm_mapped_issue_v1(snapshot_id,hold_id,state) VALUES(s.id,h.id,'issuing');
 UPDATE public.lltouch_cm_universal_holds SET state='checkout',updated_at=clock_timestamp() WHERE id=h.id RETURNING * INTO h;
 RETURN jsonb_build_object('ok',true,'state','issuing','sessionId',NULL,'hold',to_jsonb(h),'snapshot',to_jsonb(s));
END; $fn$;

-- Source block ddl11
-- Binding is also callable after the checkout deadline by a verified webhook.
CREATE FUNCTION public.lltouch_cm_mapped_issue_bind_v1(p_snapshot uuid,p_hold uuid,p_session text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE h public.lltouch_cm_universal_holds%ROWTYPE; i public.lltouch_cm_mapped_issue_v1%ROWTYPE;
BEGIN
 IF p_session IS NULL OR p_session !~ '^cs_live_[A-Za-z0-9_]{12,200}$' THEN RAISE EXCEPTION 'CM_MAPPED_SESSION_INVALID'; END IF;
 SELECT * INTO h FROM public.lltouch_cm_universal_holds WHERE id=p_hold FOR UPDATE;
 IF NOT FOUND OR h.quote_snapshot->>'mode' IS DISTINCT FROM 'mapped-service-v1' THEN RAISE EXCEPTION 'CM_MAPPED_HOLD_NOT_FOUND'; END IF;
 SELECT * INTO i FROM public.lltouch_cm_mapped_issue_v1 WHERE snapshot_id=p_snapshot AND hold_id=h.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CM_MAPPED_ISSUE_NOT_FOUND'; END IF;
 IF i.session_id=p_session AND h.stripe_session_id=p_session THEN RETURN jsonb_build_object('ok',true,'idempotent',true); END IF;
 IF i.state<>'issuing' OR i.session_id IS NOT NULL OR h.state<>'checkout' OR h.stripe_session_id IS NOT NULL THEN RAISE EXCEPTION 'CM_MAPPED_BIND_CONFLICT'; END IF;
 UPDATE public.lltouch_cm_universal_holds SET stripe_session_id=p_session,updated_at=clock_timestamp() WHERE id=h.id;
 UPDATE public.lltouch_cm_mapped_issue_v1 SET state='bound',session_id=p_session,updated_at=clock_timestamp() WHERE snapshot_id=p_snapshot;
 RETURN jsonb_build_object('ok',true,'idempotent',false);
END; $fn$;

-- Source block ddl12
-- Only the server, after authenticated Stripe retrieval, may classify an event.
-- Late/uncertain payments go to review without reoccupying an already released slot.
CREATE FUNCTION public.lltouch_cm_mapped_issue_event_v1(p_snapshot uuid,p_hold uuid,p_session text,p_event text,p_action text,p_reason text,p_paid_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE h public.lltouch_cm_universal_holds%ROWTYPE; i public.lltouch_cm_mapped_issue_v1%ROWTYPE; e public.lltouch_cm_mapped_event_v1%ROWTYPE; a text; r text;
BEGIN
 IF p_event IS NULL OR p_event !~ '^evt_[A-Za-z0-9_]{8,200}$' OR p_action IS NULL OR p_action NOT IN ('paid_candidate','expiry_candidate','review','already_reconciled','wait') OR p_reason IS NULL OR p_reason !~ '^[A-Z_]{3,80}$' THEN RAISE EXCEPTION 'CM_MAPPED_EVENT_INVALID'; END IF;
 SELECT * INTO h FROM public.lltouch_cm_universal_holds WHERE id=p_hold FOR UPDATE;
 IF NOT FOUND OR h.stripe_session_id IS DISTINCT FROM p_session OR h.quote_snapshot->>'mode' IS DISTINCT FROM 'mapped-service-v1' THEN RAISE EXCEPTION 'CM_MAPPED_EVENT_HOLD_INVALID'; END IF;
 SELECT * INTO i FROM public.lltouch_cm_mapped_issue_v1 WHERE snapshot_id=p_snapshot AND hold_id=h.id FOR UPDATE;
 IF NOT FOUND OR i.session_id IS DISTINCT FROM p_session OR i.session_id IS NULL THEN RAISE EXCEPTION 'CM_MAPPED_EVENT_ISSUE_INVALID'; END IF;
 SELECT * INTO e FROM public.lltouch_cm_mapped_event_v1 WHERE event_id=p_event;
 IF FOUND THEN
  IF e.snapshot_id IS DISTINCT FROM p_snapshot OR e.session_id IS DISTINCT FROM p_session THEN RAISE EXCEPTION 'CM_MAPPED_EVENT_ID_CONFLICT'; END IF;
  RETURN jsonb_build_object('ok',true,'duplicate',true,'action',e.action);
 END IF;
 a:=p_action; r:=p_reason;
 IF a='paid_candidate' AND i.state='paid' AND h.state IN ('paid','processing','confirmed') THEN a:='already_reconciled';r:='REPLAY_OR_IN_PROGRESS'; END IF;
 IF a='paid_candidate' AND (p_paid_at IS NULL OR p_paid_at<date_trunc('second',h.created_at) OR p_paid_at>=h.expires_at OR h.state<>'checkout' OR i.state<>'bound') THEN a:='review';r:='PAYMENT_STATE_CHANGED'; END IF;
 IF a='paid_candidate' THEN
  UPDATE public.lltouch_cm_universal_holds SET state='paid',updated_at=clock_timestamp() WHERE id=h.id;
  UPDATE public.lltouch_cm_mapped_issue_v1 SET state='paid',paid_at=p_paid_at,last_reason=r,updated_at=clock_timestamp() WHERE snapshot_id=p_snapshot;
 ELSIF a='expiry_candidate' AND h.state='checkout' AND i.state='bound' AND clock_timestamp()>=h.expires_at THEN
  UPDATE public.lltouch_cm_universal_holds SET state='expired',updated_at=clock_timestamp() WHERE id=h.id;
  UPDATE public.lltouch_cm_mapped_issue_v1 SET state='expired',last_reason=r,updated_at=clock_timestamp() WHERE snapshot_id=p_snapshot;
 ELSIF a='expiry_candidate' THEN a:='wait';r:='EXPIRY_STATE_CHANGED';
 ELSIF a='review' THEN
  -- Never overwrite confirmed/processing/paid state or resurrect an expired slot.
  IF h.state='checkout' THEN UPDATE public.lltouch_cm_universal_holds SET state='review',updated_at=clock_timestamp() WHERE id=h.id; END IF;
  IF i.state<>'paid' THEN UPDATE public.lltouch_cm_mapped_issue_v1 SET state='review',last_reason=r,updated_at=clock_timestamp() WHERE snapshot_id=p_snapshot; END IF;
 END IF;
 INSERT INTO public.lltouch_cm_mapped_event_v1(event_id,snapshot_id,session_id,action,reason) VALUES(p_event,p_snapshot,p_session,a,r);
 RETURN jsonb_build_object('ok',true,'duplicate',false,'action',a,'bookingAuthorized',false);
END; $fn$;

-- Source block ddl13
REVOKE ALL ON FUNCTION public.lltouch_cm_mapped_issue_begin_v1(uuid,uuid,uuid,uuid),public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,text),public.lltouch_cm_mapped_issue_event_v1(uuid,uuid,text,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;

-- Source block ddl14
GRANT EXECUTE ON FUNCTION public.lltouch_cm_mapped_issue_begin_v1(uuid,uuid,uuid,uuid),public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,text),public.lltouch_cm_mapped_issue_event_v1(uuid,uuid,text,text,text,text,timestamptz) TO service_role;

-- Source block ddl15
-- Candidate; apply only after emission migration and integrated review.

DO $guard$ BEGIN
 IF to_regclass('public.lltouch_cm_mapped_issue_v1') IS NULL OR
    to_regprocedure('public.lltouch_cm_mapped_issue_event_v1(uuid,uuid,text,text,text,text,timestamptz)') IS NULL THEN
   RAISE EXCEPTION 'CM_MAPPED_EMISSION_REQUIRED';
 END IF;
END $guard$;

-- Source block ddl16
CREATE FUNCTION public.lltouch_cm_mapped_due_issues_v1()
RETURNS TABLE(snapshot_id uuid,hold_id uuid,session_id text)
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
 SELECT i.snapshot_id,i.hold_id,i.session_id
 FROM public.lltouch_cm_mapped_issue_v1 i JOIN public.lltouch_cm_universal_holds h ON h.id=i.hold_id
 WHERE i.state='bound' AND i.session_id IS NOT NULL AND h.state='checkout'
   AND h.stripe_session_id=i.session_id AND h.quote_snapshot->>'mode'='mapped-service-v1'
   AND h.expires_at<=clock_timestamp()
 ORDER BY i.updated_at,i.snapshot_id LIMIT 20;
$fn$;

-- Source block ddl17
-- Separate source from signed webhook events: polling never fabricates an evt ID.
CREATE FUNCTION public.lltouch_cm_mapped_poll_result_v1(p_snapshot uuid,p_hold uuid,p_session text,p_action text,p_reason text,p_paid_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE h public.lltouch_cm_universal_holds%ROWTYPE; i public.lltouch_cm_mapped_issue_v1%ROWTYPE; a text; r text;
BEGIN
 IF p_session IS NULL OR p_session !~ '^cs_live_[A-Za-z0-9_]{12,200}$' OR p_action IS NULL OR p_action NOT IN ('paid_candidate','expiry_candidate','review','already_reconciled','wait') OR p_reason IS NULL OR p_reason !~ '^[A-Z_]{3,80}$' THEN RAISE EXCEPTION 'CM_MAPPED_POLL_INVALID'; END IF;
 -- Same lock order as signed webhook (hold then issue); conditional state transitions.
 SELECT * INTO h FROM public.lltouch_cm_universal_holds WHERE id=p_hold FOR UPDATE;
 IF NOT FOUND OR h.stripe_session_id IS DISTINCT FROM p_session OR h.quote_snapshot->>'mode' IS DISTINCT FROM 'mapped-service-v1' THEN RAISE EXCEPTION 'CM_MAPPED_POLL_HOLD_INVALID'; END IF;
 SELECT * INTO i FROM public.lltouch_cm_mapped_issue_v1 WHERE snapshot_id=p_snapshot AND hold_id=h.id FOR UPDATE;
 IF NOT FOUND OR i.session_id IS DISTINCT FROM p_session THEN RAISE EXCEPTION 'CM_MAPPED_POLL_ISSUE_INVALID'; END IF;
 IF i.state<>'bound' OR h.state<>'checkout' THEN RETURN jsonb_build_object('ok',true,'action','already_reconciled'); END IF;
 IF h.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'CM_MAPPED_POLL_NOT_DUE'; END IF;
 a:=p_action;r:=p_reason;
 IF a='paid_candidate' AND (p_paid_at IS NULL OR p_paid_at<date_trunc('second',h.created_at) OR p_paid_at>=h.expires_at) THEN a:='review';r:='PAYMENT_STATE_CHANGED'; END IF;
 IF a='paid_candidate' THEN
   UPDATE public.lltouch_cm_universal_holds SET state='paid',updated_at=clock_timestamp() WHERE id=h.id;
   UPDATE public.lltouch_cm_mapped_issue_v1 SET state='paid',paid_at=p_paid_at,last_reason=r,updated_at=clock_timestamp() WHERE snapshot_id=p_snapshot;
 ELSIF a='expiry_candidate' THEN
   UPDATE public.lltouch_cm_universal_holds SET state='expired',updated_at=clock_timestamp() WHERE id=h.id;
   UPDATE public.lltouch_cm_mapped_issue_v1 SET state='expired',last_reason=r,updated_at=clock_timestamp() WHERE snapshot_id=p_snapshot;
 ELSIF a='review' THEN
   UPDATE public.lltouch_cm_universal_holds SET state='review',updated_at=clock_timestamp() WHERE id=h.id;
   UPDATE public.lltouch_cm_mapped_issue_v1 SET state='review',last_reason=r,updated_at=clock_timestamp() WHERE snapshot_id=p_snapshot;
 ELSE
   UPDATE public.lltouch_cm_mapped_issue_v1 SET last_reason=r,updated_at=clock_timestamp() WHERE snapshot_id=p_snapshot;
 END IF;
 RETURN jsonb_build_object('ok',true,'action',a,'bookingAuthorized',false);
END $fn$;

-- Source block ddl18
REVOKE ALL ON FUNCTION public.lltouch_cm_mapped_due_issues_v1(),public.lltouch_cm_mapped_poll_result_v1(uuid,uuid,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;

-- Source block ddl19
GRANT EXECUTE ON FUNCTION public.lltouch_cm_mapped_due_issues_v1(),public.lltouch_cm_mapped_poll_result_v1(uuid,uuid,text,text,text,timestamptz) TO service_role;

-- Source block ddl20
-- Candidate only. Apply AFTER emission and expiry migrations, after QA review.

DO $$ BEGIN
 IF to_regclass('public.lltouch_cm_mapped_issue_v1') IS NULL OR to_regprocedure('public.lltouch_cm_mapped_poll_result_v1(uuid,uuid,text,text,text,timestamptz)') IS NULL THEN RAISE EXCEPTION 'CM_MAPPED_PREREQUISITE_MISSING'; END IF;
END $$;

-- Source block ddl21
CREATE TABLE public.lltouch_cm_mapped_booking_v1 (
 hold_id uuid PRIMARY KEY REFERENCES public.lltouch_cm_universal_holds(id) ON DELETE RESTRICT,
 snapshot_id uuid NOT NULL UNIQUE REFERENCES public.lltouch_cm_mapped_issue_v1(snapshot_id) ON DELETE RESTRICT,
 state text NOT NULL CHECK(state IN ('processing','calendar_verified','review')),
 booking_id uuid UNIQUE REFERENCES public.lltouch_appointments(id) ON DELETE RESTRICT,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 CHECK ((state='calendar_verified')=(booking_id IS NOT NULL))
);

-- Source block ddl22
ALTER TABLE public.lltouch_cm_mapped_booking_v1 ENABLE ROW LEVEL SECURITY;

-- Source block ddl23
REVOKE ALL ON public.lltouch_cm_mapped_booking_v1 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.lltouch_cm_mapped_booking_v1 FROM service_role;

-- Source block ddl24
GRANT SELECT,INSERT,UPDATE ON public.lltouch_cm_mapped_booking_v1 TO service_role;

-- Source block ddl25
CREATE FUNCTION public.lltouch_cm_mapped_booking_claim_v1() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE h public.lltouch_cm_universal_holds%ROWTYPE; s public.lltouch_cm_universal_checkout_snapshots%ROWTYPE; i public.lltouch_cm_mapped_issue_v1%ROWTYPE;
BEGIN
 SELECT x.* INTO h FROM public.lltouch_cm_universal_holds x JOIN public.lltouch_cm_mapped_issue_v1 y ON y.hold_id=x.id
 WHERE x.state='paid' AND y.state='paid' AND y.session_id=x.stripe_session_id AND x.quote_snapshot->>'mode'='mapped-service-v1'
 ORDER BY y.paid_at,x.id LIMIT 1 FOR UPDATE OF x SKIP LOCKED;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'claimed',false); END IF;
 SELECT * INTO i FROM public.lltouch_cm_mapped_issue_v1 WHERE hold_id=h.id FOR UPDATE;
 SELECT * INTO s FROM public.lltouch_cm_universal_checkout_snapshots WHERE id=i.snapshot_id AND hold_id=h.id;
 IF NOT FOUND OR i.state<>'paid' OR i.paid_at IS NULL OR i.paid_at>=h.expires_at OR i.paid_at<date_trunc('second',h.created_at) OR i.session_id IS DISTINCT FROM h.stripe_session_id OR s.immutable_terms IS DISTINCT FROM h.quote_snapshot OR s.campaign_id IS DISTINCT FROM h.campaign_id OR s.campaign_version IS DISTINCT FROM h.campaign_version OR s.campaign_key IS DISTINCT FROM h.campaign_key THEN RAISE EXCEPTION 'CM_MAPPED_BOOKING_TERMS_INVALID'; END IF;
 INSERT INTO public.lltouch_cm_mapped_booking_v1(hold_id,snapshot_id,state) VALUES(h.id,s.id,'processing');
 UPDATE public.lltouch_cm_universal_holds SET state='processing',updated_at=clock_timestamp() WHERE id=h.id RETURNING * INTO h;
 RETURN jsonb_build_object('ok',true,'claimed',true,'hold',to_jsonb(h),'snapshot',to_jsonb(s));
END $$;

-- Source block ddl26
CREATE FUNCTION public.lltouch_cm_mapped_booking_finish_v1(p_hold uuid,p_snapshot uuid,p_booking uuid,p_outcome text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE h public.lltouch_cm_universal_holds%ROWTYPE; b public.lltouch_cm_mapped_booking_v1%ROWTYPE; a public.lltouch_appointments%ROWTYPE;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('calendar_verified','review') OR ((p_outcome='calendar_verified') IS DISTINCT FROM (p_booking IS NOT NULL)) THEN RAISE EXCEPTION 'CM_MAPPED_BOOKING_OUTCOME_INVALID'; END IF;
 SELECT * INTO h FROM public.lltouch_cm_universal_holds WHERE id=p_hold FOR UPDATE;
 IF NOT FOUND OR h.quote_snapshot->>'mode' IS DISTINCT FROM 'mapped-service-v1' THEN RAISE EXCEPTION 'CM_MAPPED_BOOKING_HOLD_INVALID'; END IF;
 SELECT * INTO b FROM public.lltouch_cm_mapped_booking_v1 WHERE hold_id=h.id AND snapshot_id=p_snapshot FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CM_MAPPED_BOOKING_CLAIM_MISSING'; END IF;
 IF b.state=p_outcome AND b.booking_id IS NOT DISTINCT FROM p_booking THEN RETURN jsonb_build_object('ok',true,'idempotent',true); END IF;
 IF b.state<>'processing' OR h.state<>'processing' THEN RAISE EXCEPTION 'CM_MAPPED_BOOKING_STATE_CHANGED'; END IF;
 IF p_outcome='calendar_verified' THEN
   SELECT * INTO a FROM public.lltouch_appointments WHERE id=p_booking FOR SHARE;
   IF NOT FOUND OR a.status IS DISTINCT FROM 'confirmed' OR a.stripe_session_id IS DISTINCT FROM h.stripe_session_id OR a.provider_id IS DISTINCT FROM h.quote_snapshot->>'providerId' OR a.service_id IS DISTINCT FROM h.quote_snapshot->>'serviceId' OR a.starts_at IS DISTINCT FROM h.appointment_start OR a.ends_at IS DISTINCT FROM h.appointment_end OR a.paid_total_cents IS DISTINCT FROM (h.quote_snapshot->>'depositCents')::integer OR a.google_event_id IS NULL THEN RAISE EXCEPTION 'CM_MAPPED_BOOKING_RECORD_MISMATCH'; END IF;
   -- Remain blocked until Vagaro synchronization has independently been verified.
 END IF;
 UPDATE public.lltouch_cm_mapped_booking_v1 SET state=p_outcome,booking_id=p_booking,finished_at=clock_timestamp() WHERE hold_id=h.id;
 UPDATE public.lltouch_cm_universal_holds SET state='review',updated_at=clock_timestamp() WHERE id=h.id;
 RETURN jsonb_build_object('ok',true,'calendarVerified',p_outcome='calendar_verified','vagaroVerified',false,'customerConfirmationAuthorized',false);
END $$;

-- Source block ddl27
REVOKE ALL ON FUNCTION public.lltouch_cm_mapped_booking_claim_v1(),public.lltouch_cm_mapped_booking_finish_v1(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;

-- Source block ddl28
GRANT EXECUTE ON FUNCTION public.lltouch_cm_mapped_booking_claim_v1(),public.lltouch_cm_mapped_booking_finish_v1(uuid,uuid,uuid,text) TO service_role;

-- Source block ddl29
DO $verify$
DECLARE f regprocedure; t regclass; n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['public.lltouch_cm_mapped_issue_begin_v1(uuid,uuid,uuid,uuid)', 'public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,text)', 'public.lltouch_cm_mapped_issue_event_v1(uuid,uuid,text,text,text,text,timestamptz)', 'public.lltouch_cm_mapped_due_issues_v1()', 'public.lltouch_cm_mapped_poll_result_v1(uuid,uuid,text,text,text,timestamptz)', 'public.lltouch_cm_mapped_booking_claim_v1()', 'public.lltouch_cm_mapped_booking_finish_v1(uuid,uuid,uuid,text)'] LOOP
    f:=to_regprocedure(n);
    IF f IS NULL THEN RAISE EXCEPTION 'STOP | RPC ausente: %',n; END IF;
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'STOP | permissoes RPC invalidas: %',n; END IF;
    IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND prosecdef) THEN RAISE EXCEPTION 'STOP | RPC nao e SECURITY INVOKER: %',n; END IF;
  END LOOP;
  FOREACH n IN ARRAY ARRAY['public.lltouch_cm_mapped_issue_v1', 'public.lltouch_cm_mapped_event_v1', 'public.lltouch_cm_mapped_booking_v1'] LOOP
    t:=to_regclass(n);
    IF t IS NULL THEN RAISE EXCEPTION 'STOP | tabela ausente: %',n; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=t AND relrowsecurity) THEN RAISE EXCEPTION 'STOP | RLS desativado: %',n; END IF;
    IF has_table_privilege('anon',t,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated',t,'SELECT,INSERT,UPDATE,DELETE') OR NOT has_table_privilege('service_role',t,'SELECT') THEN RAISE EXCEPTION 'STOP | permissoes tabela invalidas: %',n; END IF;
  END LOOP;
END $verify$;
COMMIT;
