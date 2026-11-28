-- Read-only verification after the 05C candidate migrations are installed.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';

DO $verify$
DECLARE
  expected record;
  actual pg_proc%ROWTYPE;
  ledger regclass;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('lltouch_cm_commercial_active_v1(uuid,integer)', true, true),
    ('lltouch_cm_commercial_status_v1(text)', true, true),
    ('lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz)', true, true),
    ('lltouch_cm_commercial_submit_v1(text,integer,uuid,text,text,text,boolean,boolean)', false, true),
    ('lltouch_cm_commercial_material_v1(public.lltouch_campaigns)', false, false),
    ('lltouch_cm_commercial_review_token_v1(public.lltouch_campaigns)', false, false),
    ('lltouch_cm_commercial_assert_plan_v1(public.lltouch_campaigns)', false, false),
    ('lltouch_cm_commercial_disable_capture_v1(text)', false, false),
    ('lltouch_cm_commercial_invalidate_v1(public.lltouch_campaigns,text,integer)', false, false),
    ('lltouch_cm_commercial_campaign_guard_v1()', true, false),
    ('lltouch_cm_commercial_asset_guard_v1()', true, false),
    ('lltouch_cm_commercial_capture_setting_guard_v1()', true, false),
    ('lltouch_cm_commercial_lead_guard_v1()', true, false),
    ('lltouch_cm_commercial_ghl_begin_effect_v1(text,integer,uuid,uuid,text,text)', true, true),
    ('lltouch_cm_commercial_dependencies_v1()', false, true),
    ('lltouch_cm_commercial_metrics_v1(uuid)', false, true)
  ) AS functions(signature, security_definer, service_exec) LOOP
    SELECT * INTO actual FROM pg_proc WHERE oid = to_regprocedure('public.' || expected.signature);
    IF NOT FOUND OR actual.prokind <> 'f' OR actual.prosecdef IS DISTINCT FROM expected.security_definer
       OR NOT COALESCE(actual.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)
       OR pg_get_userbyid(actual.proowner) IN ('anon','authenticated','service_role')
       OR has_function_privilege('service_role', actual.oid, 'EXECUTE') IS DISTINCT FROM expected.service_exec
       OR has_function_privilege('anon', actual.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', actual.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'CM_PREVIEW_FUNCTION_CONTRACT_INVALID: %', expected.signature;
    END IF;
  END LOOP;

  FOR expected IN SELECT * FROM (VALUES
    ('lltouch_cm_commercial_authorization_v1'), ('lltouch_cm_commercial_audit_v1')
  ) AS ledgers(name) LOOP
    ledger := to_regclass('public.' || expected.name);
    IF ledger IS NULL OR NOT EXISTS (SELECT FROM pg_class c WHERE c.oid = ledger AND c.relkind = 'r' AND c.relrowsecurity
        AND pg_get_userbyid(c.relowner) NOT IN ('anon','authenticated','service_role'))
       OR has_table_privilege('anon', ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('service_role', ledger, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'CM_PREVIEW_LEDGER_CONTRACT_INVALID: %', expected.name;
    END IF;
  END LOOP;

  FOR expected IN SELECT * FROM (VALUES
    ('lltouch_campaigns', 'lltouch_cm_commercial_campaign_guard_v1', 23),
    ('lltouch_campaign_assets', 'lltouch_cm_commercial_asset_guard_v1', 29),
    ('lltouch_cm_lead_capture_settings', 'lltouch_cm_commercial_capture_setting_guard_v1', 23),
    ('lltouch_cm_leads', 'lltouch_cm_commercial_lead_guard_v1', 7)
  ) AS guards(relation, name, trigger_type) LOOP
    IF NOT EXISTS (SELECT FROM pg_trigger t WHERE t.tgname = expected.name AND NOT t.tgisinternal
      AND t.tgrelid = to_regclass('public.' || expected.relation)
      AND t.tgfoid = to_regprocedure('public.' || expected.name || '()')
      AND t.tgtype = expected.trigger_type AND t.tgenabled IN ('O','A')) THEN
      RAISE EXCEPTION 'CM_PREVIEW_GUARD_NOT_ACTIVE: %', expected.name;
    END IF;
  END LOOP;
END
$verify$;

SELECT 'VERIFIED' AS candidate_catalog, 16 AS functions_checked, 2 AS rls_ledgers_checked, 4 AS triggers_checked;
SELECT p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       pg_get_userbyid(p.proowner) AS owner_name,
       md5(btrim(p.prosrc, E' \n\r\t')) AS body_fingerprint
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND starts_with(p.proname, 'lltouch_cm_commercial_') AND p.prokind = 'f'
ORDER BY p.proname, identity_arguments;
COMMIT;
