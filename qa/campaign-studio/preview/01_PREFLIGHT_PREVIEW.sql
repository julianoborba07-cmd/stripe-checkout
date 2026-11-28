-- Read-only inventory. Confirm the target is the authorized PREVIEW project before running.
BEGIN READ ONLY;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

DO $roles$
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'CM_PREVIEW_DATABASE_ROLES_MISSING';
  END IF;
END
$roles$;

SELECT current_database() AS database_name, current_user AS execution_role,
       current_setting('transaction_read_only') AS read_only,
       current_setting('server_version') AS server_version;

-- The established PREVIEW contract has 19 RPCs. The authoring RPC is an
-- additional dependency of the current panel. Check named inputs used by the
-- HTTP client, including overload collisions and effective role grants.
WITH expected(api, rpc, inputs) AS (VALUES
  ('baseline','lltouch_cm_display_release', ARRAY['p_campaign_key','p_expected_version','p_action']),
  ('baseline','lltouch_cm_lead_capture_configure', ARRAY['p_campaign_key','p_expected_version','p_enabled']),
  ('baseline','lltouch_cm_lead_capture_submit', ARRAY['p_campaign_key','p_campaign_version','p_client_nonce',
    'p_customer_name','p_customer_email','p_customer_phone','p_contact_consent','p_sms_marketing_consent']),
  ('baseline','lltouch_cm_mapped_reserve_v1', ARRAY['p_campaign_key','p_campaign_version','p_lead_id','p_client_nonce',
    'p_provider_key','p_provider_id','p_service_id','p_start']),
  ('baseline','lltouch_cm_mapped_issue_begin_v1', ARRAY['p_hold','p_snapshot','p_nonce','p_lead']),
  ('baseline','lltouch_cm_mapped_issue_bind_v1', ARRAY['p_snapshot','p_hold','p_session']),
  ('baseline','lltouch_cm_mapped_issue_event_v1', ARRAY['p_snapshot','p_hold','p_session','p_event','p_action','p_reason','p_paid_at']),
  ('baseline','lltouch_cm_mapped_due_issues_v1', ARRAY[]::text[]),
  ('baseline','lltouch_cm_mapped_poll_result_v1', ARRAY['p_snapshot','p_hold','p_session','p_action','p_reason','p_paid_at']),
  ('baseline','lltouch_cm_mapped_booking_claim_v1', ARRAY[]::text[]),
  ('baseline','lltouch_cm_mapped_booking_finish_v1', ARRAY['p_hold','p_snapshot','p_booking','p_outcome']),
  ('baseline','lltouch_cm_ghl_auto_candidates', ARRAY['p_limit','p_campaign_key']),
  ('baseline','lltouch_cm_ghl_claim_one', ARRAY['p_campaign_key','p_expected_version']),
  ('baseline','lltouch_cm_ghl_effect_checkpoint', ARRAY['p_lead_id','p_lease_token','p_expected_step','p_next_step']),
  ('baseline','lltouch_cm_ghl_record_contact', ARRAY['p_lead_id','p_lease_token','p_ghl_contact_id']),
  ('baseline','lltouch_cm_ghl_finish', ARRAY['p_lead_id','p_lease_token']),
  ('baseline','lltouch_cm_ghl_retry', ARRAY['p_lead_id','p_lease_token','p_reason']),
  ('baseline','lltouch_cm_ghl_queue_health', ARRAY['p_campaign_key']),
  ('baseline','lltouch_cm_ghl_effect_health', ARRAY['p_campaign_key']),
  ('authoring','lltouch_cm_save_webflow_ai_draft', ARRAY['p_campaign_key','p_expected_version','p_service_title',
    'p_regular_cents','p_offer_cents','p_deposit_cents','p_desktop_url','p_mobile_url','p_start_date','p_end_date','p_marketing','p_is_update'])
), inventory AS (
  SELECT e.api, e.rpc, count(p.oid) AS matching_overloads,
         COALESCE(bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')), false) AS grants_valid,
         array_agg(pg_get_function_identity_arguments(p.oid) ORDER BY p.oid) FILTER (WHERE p.oid IS NOT NULL) AS identities
  FROM expected e
  LEFT JOIN LATERAL (
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = e.rpc
      AND p.pronargs >= cardinality(e.inputs)
      AND COALESCE(p.proargnames[1:p.pronargs], ARRAY[]::text[]) @> e.inputs
      AND e.inputs @> COALESCE(p.proargnames[1:(p.pronargs - p.pronargdefaults)], ARRAY[]::text[])
  ) p ON true
  GROUP BY e.api, e.rpc
)
SELECT api, count(*) AS expected,
       count(*) FILTER (WHERE matching_overloads = 1 AND grants_valid) AS verified,
       COALESCE(jsonb_object_agg(rpc, jsonb_build_object('overloads', matching_overloads, 'grantsValid', grants_valid,
         'identities', identities)) FILTER (WHERE matching_overloads <> 1 OR NOT grants_valid), '{}'::jsonb) AS blockers
FROM inventory GROUP BY api ORDER BY api;

WITH required(relation, columns) AS (VALUES
  ('lltouch_campaigns', ARRAY['id','campaign_key','version','status','offer_starts_at','offer_ends_at','marketing']),
  ('lltouch_campaign_assets', ARRAY['campaign_id','asset_type','device','position','image_url']),
  ('lltouch_cm_lead_capture_settings', ARRAY['campaign_key','campaign_version','enabled','revision','updated_at']),
  ('lltouch_cm_leads', ARRAY['id','campaign_id','campaign_key','campaign_version','client_nonce','contact_consent','sms_marketing_consent']),
  ('lltouch_cm_lead_outbox', ARRAY['lead_id','campaign_key','lease_token','state','external_step',
    'reconciliation_required','ghl_contact_id']),
  ('lltouch_cm_universal_holds', ARRAY['id','campaign_id','state','quote_snapshot','expires_at']),
  ('lltouch_cm_universal_checkout_snapshots', ARRAY['id','hold_id','immutable_terms']),
  ('lltouch_cm_mapped_issue_v1', ARRAY['snapshot_id','hold_id','state','session_id','paid_at']),
  ('lltouch_cm_mapped_event_v1', ARRAY['event_id','snapshot_id','action','reason']),
  ('lltouch_cm_mapped_booking_v1', ARRAY['hold_id','snapshot_id','state','started_at']),
  ('lltouch_offer_claims', ARRAY['provider_id','state','starts_at','ends_at']),
  ('lltouch_appointments', ARRAY['provider_id','status','starts_at','ends_at','stripe_session_id','google_event_id'])
)
SELECT r.relation, COALESCE(c.relkind IN ('r','p'), false) AS table_present,
       ARRAY(SELECT expected FROM unnest(r.columns) expected WHERE NOT EXISTS (
         SELECT FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = expected
           AND a.attnum > 0 AND NOT a.attisdropped)) AS missing_columns
FROM required r LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || r.relation)
ORDER BY r.relation;

-- A partial or divergent installation is a stop for investigation. The
-- complete catalog must still pass detailed verification before skipping it.
WITH expected(migration, kind, identity) AS (VALUES
  ('05c-01','table','lltouch_cm_commercial_authorization_v1'),
  ('05c-01','table','lltouch_cm_commercial_audit_v1'),
  ('05c-01','function','lltouch_cm_commercial_active_v1(uuid,integer)'),
  ('05c-01','function','lltouch_cm_commercial_status_v1(text)'),
  ('05c-01','function','lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz)'),
  ('05c-01','function','lltouch_cm_commercial_submit_v1(text,integer,uuid,text,text,text,boolean,boolean)'),
  ('05c-01','function','lltouch_cm_commercial_material_v1(public.lltouch_campaigns)'),
  ('05c-01','function','lltouch_cm_commercial_review_token_v1(public.lltouch_campaigns)'),
  ('05c-01','function','lltouch_cm_commercial_assert_plan_v1(public.lltouch_campaigns)'),
  ('05c-01','function','lltouch_cm_commercial_disable_capture_v1(text)'),
  ('05c-01','function','lltouch_cm_commercial_invalidate_v1(public.lltouch_campaigns,text,integer)'),
  ('05c-01','function','lltouch_cm_commercial_campaign_guard_v1()'),
  ('05c-01','function','lltouch_cm_commercial_asset_guard_v1()'),
  ('05c-01','function','lltouch_cm_commercial_capture_setting_guard_v1()'),
  ('05c-01','function','lltouch_cm_commercial_lead_guard_v1()'),
  ('05c-01','trigger','lltouch_cm_commercial_campaign_guard_v1'),
  ('05c-01','trigger','lltouch_cm_commercial_asset_guard_v1'),
  ('05c-01','trigger','lltouch_cm_commercial_capture_setting_guard_v1'),
  ('05c-01','trigger','lltouch_cm_commercial_lead_guard_v1'),
  ('05c-02','function','lltouch_cm_commercial_ghl_begin_effect_v1(text,integer,uuid,uuid,text,text)'),
  ('05c-03','function','lltouch_cm_commercial_dependencies_v1()'),
  ('05c-03','function','lltouch_cm_commercial_metrics_v1(uuid)')
), presence AS (
  SELECT e.*, CASE kind
    WHEN 'table' THEN (SELECT count(*) FROM pg_class c WHERE c.oid = to_regclass('public.' || e.identity))
    WHEN 'trigger' THEN (SELECT count(*) FROM pg_trigger t WHERE t.tgname = e.identity AND NOT t.tgisinternal)
    ELSE (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = split_part(e.identity, '(', 1)) END AS matches,
    CASE kind
      WHEN 'table' THEN EXISTS (SELECT FROM pg_class c WHERE c.oid = to_regclass('public.' || e.identity) AND c.relkind = 'r')
      WHEN 'trigger' THEN EXISTS (SELECT FROM pg_trigger t WHERE t.tgname = e.identity AND NOT t.tgisinternal AND t.tgenabled IN ('O','A'))
      ELSE to_regprocedure('public.' || e.identity) IS NOT NULL END AS expected_shape
  FROM expected e
)
SELECT migration, CASE WHEN bool_and(matches = 0) THEN 'ABSENT'
                       WHEN bool_and(matches = 1 AND expected_shape) THEN 'PRESENT_VERIFY'
                       ELSE 'PARTIAL_OR_DIFFERENT' END AS installation_state,
       array_agg(identity ORDER BY identity) FILTER (WHERE matches <> 1 OR NOT expected_shape) AS review_objects
FROM presence GROUP BY migration ORDER BY migration;

DO $flags$
BEGIN
  IF to_regclass('public.lltouch_campaigns') IS NULL THEN
    RAISE EXCEPTION 'CM_PREVIEW_CAMPAIGNS_TABLE_MISSING';
  END IF;
END
$flags$;

SELECT count(*) AS campaigns_total, count(*) FILTER (WHERE status = 'published') AS published,
       count(*) FILTER (WHERE marketing #> '{campaignMeta,mappedReservationAuthorized}' = 'true'::jsonb
         OR marketing #> '{campaignMeta,mappedCheckoutAuthorized}' = 'true'::jsonb) AS mapped_flags_enabled
FROM public.lltouch_campaigns;

COMMIT;
