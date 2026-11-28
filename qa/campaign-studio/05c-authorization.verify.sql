-- Read-only assertions for a database that already has migration 05c-01.
BEGIN READ ONLY;
DO $verify$
DECLARE
  rpc regprocedure;
  t regclass;
BEGIN
  FOREACH rpc IN ARRAY ARRAY[
      'public.lltouch_cm_commercial_active_v1(uuid,integer)'::regprocedure,
      'public.lltouch_cm_commercial_status_v1(text)'::regprocedure,
      'public.lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz)'::regprocedure,
      'public.lltouch_cm_commercial_submit_v1(text,integer,uuid,text,text,text,boolean,boolean)'::regprocedure
  ] LOOP
    IF has_function_privilege('anon', rpc, 'EXECUTE') OR has_function_privilege('authenticated', rpc, 'EXECUTE') OR
       NOT has_function_privilege('service_role', rpc, 'EXECUTE') THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_RPC_GRANTS_INVALID: %', rpc;
    END IF;
  END LOOP;

  rpc := 'public.lltouch_cm_commercial_review_token_v1(public.lltouch_campaigns)'::regprocedure;
  IF has_function_privilege('anon', rpc, 'EXECUTE') OR has_function_privilege('authenticated', rpc, 'EXECUTE') OR
     has_function_privilege('service_role', rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_REVIEW_HELPER_GRANTS_INVALID';
  END IF;

  FOREACH t IN ARRAY ARRAY['public.lltouch_cm_commercial_authorization_v1'::regclass,
      'public.lltouch_cm_commercial_audit_v1'::regclass] LOOP
    IF NOT EXISTS (SELECT FROM pg_class WHERE oid = t AND relrowsecurity) OR
       has_table_privilege('anon', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR
       has_table_privilege('authenticated', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR
       has_table_privilege('service_role', t, 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION 'CM_COMMERCIAL_TABLE_GRANTS_INVALID: %', t;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger WHERE tgenabled IN ('O','A') AND tgname IN (
      'lltouch_cm_commercial_campaign_guard_v1', 'lltouch_cm_commercial_asset_guard_v1',
      'lltouch_cm_commercial_capture_setting_guard_v1', 'lltouch_cm_commercial_lead_guard_v1')) <> 4 THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_GUARDS_MISSING';
  END IF;

  IF EXISTS (SELECT FROM public.lltouch_campaigns c LEFT JOIN public.lltouch_cm_commercial_authorization_v1 a
      ON c.id = a.campaign_id WHERE (c.marketing #> '{campaignMeta,mappedReservationAuthorized}' = 'true'::jsonb OR
        c.marketing #> '{campaignMeta,mappedCheckoutAuthorized}' = 'true'::jsonb) AND
      (a.state IS DISTINCT FROM 'activated' OR a.campaign_version IS DISTINCT FROM c.version OR c.status <> 'published')) THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_UNTRACKED_RELEASE_PRESENT';
  END IF;
END;
$verify$;
SELECT 'Commercial authorization grants, RLS, guards and materialized approvals verified' AS result;
COMMIT;
