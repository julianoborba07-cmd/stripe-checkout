-- Read-only comparison with the reviewed 05A mapped baseline.
-- Use the installer only when the baseline state is ABSENT and both prerequisites pass.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';

WITH expected_functions(signature, body_hash) AS (VALUES
  ('public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz)', '637e0ea85e63f1343f855fcceedc1c6c'),
  ('public.lltouch_cm_mapped_issue_begin_v1(uuid,uuid,uuid,uuid)', 'c50cbda22f601d92b553e8bf2c017ab6'),
  ('public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,text)', 'fa605120e57330f10d8f7437c3a349c3'),
  ('public.lltouch_cm_mapped_issue_event_v1(uuid,uuid,text,text,text,text,timestamptz)', '1f10bf6ec093fba036e7f8507494736f'),
  ('public.lltouch_cm_mapped_due_issues_v1()', 'e2ce12f0e737f1ab32a1043fab423aab'),
  ('public.lltouch_cm_mapped_poll_result_v1(uuid,uuid,text,text,text,timestamptz)', 'bcb72f3abcfc9f21cb46a6bc5f11a1c9'),
  ('public.lltouch_cm_mapped_booking_claim_v1()', '022f2dc6501974540c361d1f37671031'),
  ('public.lltouch_cm_mapped_booking_finish_v1(uuid,uuid,uuid,text)', '1df0a842d9ccd700b9aa469604549cde')
), expected_ledgers(relation, permits_update, constraint_count) AS (VALUES
  ('public.lltouch_cm_mapped_issue_v1', true, 9),
  ('public.lltouch_cm_mapped_event_v1', false, 4),
  ('public.lltouch_cm_mapped_booking_v1', true, 8)
), objects(name, present, verified) AS (
  SELECT e.signature, p.oid IS NOT NULL,
    p.oid IS NOT NULL AND NOT p.prosecdef
    AND md5(btrim(p.prosrc, E' \n\r\t')) = e.body_hash
    AND p.proconfig = ARRAY['search_path=public, pg_temp']
    AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  FROM expected_functions e LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.signature)
  UNION ALL
  SELECT e.relation, t.oid IS NOT NULL,
    t.oid IS NOT NULL AND t.relkind = 'r' AND t.relrowsecurity
    AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = t.oid AND c.convalidated AND c.contype IN ('p', 'u', 'c', 'f')) = e.constraint_count
    AND NOT EXISTS (SELECT FROM pg_constraint c WHERE c.conrelid = t.oid AND c.contype = 'f' AND c.confdeltype <> 'r')
    AND has_table_privilege('service_role', t.oid, 'SELECT')
    AND has_table_privilege('service_role', t.oid, 'INSERT')
    AND has_table_privilege('service_role', t.oid, 'UPDATE') = e.permits_update
    AND NOT has_table_privilege('service_role', t.oid, 'DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('anon', t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('authenticated', t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  FROM expected_ledgers e LEFT JOIN pg_class t ON t.oid = to_regclass(e.relation)
)
SELECT CASE
    WHEN count(*) FILTER (WHERE present) = 0 THEN 'ABSENT'
    WHEN NOT bool_and(present) THEN 'PARTIAL'
    WHEN bool_and(verified IS TRUE) THEN 'VERIFIED'
    ELSE 'DIFFERENT'
  END AS baseline_state,
  array_agg(name ORDER BY name) FILTER (WHERE present AND verified IS NOT TRUE) AS different_objects,
  array_agg(name ORDER BY name) FILTER (WHERE NOT present) AS missing_objects,
  EXISTS (SELECT FROM pg_constraint c WHERE c.conrelid = to_regclass('public.lltouch_cm_universal_holds')
    AND c.conname = 'llt_cm_active_provider_overlap_excl' AND c.contype = 'x' AND c.convalidated) AS hold_exclusion_verified,
  EXISTS (SELECT FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.lltouch_cm_universal_checkout_snapshots')
    AND t.tgname = 'll_cm_universal_snapshot_immutable_trg' AND t.tgenabled IN ('O', 'A')) AS snapshot_immutability_verified
FROM objects;

COMMIT;
