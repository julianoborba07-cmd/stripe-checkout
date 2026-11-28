-- Read existing ledgers in one snapshot. No customer data is returned.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.lltouch_cm_commercial_dependencies_v1()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH required(component, rpc, named_args, identity_types) AS (VALUES
    ('authoring','lltouch_cm_save_webflow_ai_draft','p_campaign_key,p_expected_version,p_service_title,p_regular_cents,p_offer_cents,p_deposit_cents,p_desktop_url,p_mobile_url,p_start_date,p_end_date,p_marketing,p_is_update',NULL),
    ('capture','lltouch_cm_commercial_status_v1','p_campaign_key','text'),
    ('capture','lltouch_cm_commercial_lifecycle_v1','p_campaign_key,p_expected_version,p_expected_revision,p_action,p_actor,p_review,p_scheduled_at','text,integer,integer,text,text,jsonb,timestamptz'),
    ('capture','lltouch_cm_lead_capture_configure','p_campaign_key,p_expected_version,p_enabled','text,integer,boolean'),
    ('capture','lltouch_cm_lead_capture_submit','p_campaign_key,p_campaign_version,p_client_nonce,p_customer_name,p_customer_email,p_customer_phone,p_contact_consent,p_sms_marketing_consent','text,integer,uuid,text,text,text,boolean,boolean'),
    ('capture','lltouch_cm_commercial_submit_v1','p_campaign_key,p_campaign_version,p_client_nonce,p_customer_name,p_customer_email,p_customer_phone,p_contact_consent,p_sms_marketing_consent','text,integer,uuid,text,text,text,boolean,boolean'),
    ('crm','lltouch_cm_ghl_auto_candidates','p_limit,p_campaign_key',NULL),
    ('crm','lltouch_cm_ghl_claim_one','p_campaign_key,p_expected_version',NULL),
    ('crm','lltouch_cm_ghl_effect_checkpoint','p_lead_id,p_lease_token,p_expected_step,p_next_step','uuid,uuid,text,text'),
    ('crm','lltouch_cm_ghl_record_contact','p_lead_id,p_lease_token,p_ghl_contact_id',NULL),
    ('crm','lltouch_cm_ghl_finish','p_lead_id,p_lease_token',NULL),
    ('crm','lltouch_cm_ghl_retry','p_lead_id,p_lease_token,p_reason',NULL),
    ('crm','lltouch_cm_commercial_ghl_begin_effect_v1','p_campaign_key,p_expected_version,p_lead_id,p_lease_token,p_expected_step,p_next_step','text,integer,uuid,uuid,text,text'),
    ('reservation','lltouch_cm_mapped_reserve_v1','p_campaign_key,p_campaign_version,p_lead_id,p_client_nonce,p_provider_key,p_provider_id,p_service_id,p_start','text,integer,uuid,uuid,text,text,text,timestamptz'),
    ('stripe','lltouch_cm_mapped_issue_begin_v1','p_hold,p_snapshot,p_nonce,p_lead','uuid,uuid,uuid,uuid'),
    ('stripe','lltouch_cm_mapped_issue_bind_v1','p_snapshot,p_hold,p_session','uuid,uuid,text'),
    ('stripe','lltouch_cm_mapped_issue_event_v1','p_snapshot,p_hold,p_session,p_event,p_action,p_reason,p_paid_at','uuid,uuid,text,text,text,text,timestamptz'),
    ('stripe','lltouch_cm_mapped_due_issues_v1','',''),
    ('stripe','lltouch_cm_mapped_poll_result_v1','p_snapshot,p_hold,p_session,p_action,p_reason,p_paid_at','uuid,uuid,text,text,text,timestamptz'),
    ('booking','lltouch_cm_mapped_booking_claim_v1','',''),
    ('booking','lltouch_cm_mapped_booking_finish_v1','p_hold,p_snapshot,p_booking,p_outcome','uuid,uuid,uuid,text')
  ), missing AS (
    -- PostgREST selects RPCs by named inputs. A different overload or ambiguous
    -- matches must not make a dependency look usable.
    SELECT r.component FROM required r WHERE (
      SELECT count(*) = 1 AND bool_and(
        (r.identity_types IS NULL OR p.oid = to_regprocedure(format('public.%I(%s)', r.rpc, r.identity_types)))
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = r.rpc AND p.prokind = 'f'
        AND p.pronargs = cardinality(string_to_array(r.named_args, ','))
        AND COALESCE(p.proargnames[1:p.pronargs], '{}'::text[]) @> string_to_array(r.named_args, ',')
    ) IS DISTINCT FROM true
    UNION
    SELECT 'reservation' WHERE NOT EXISTS (
      SELECT FROM pg_catalog.pg_constraint
      WHERE conrelid = to_regclass('public.lltouch_cm_universal_holds')
        AND conname = 'llt_cm_active_provider_overlap_excl' AND contype = 'x' AND convalidated
    ) OR NOT EXISTS (
      SELECT FROM pg_catalog.pg_trigger
      WHERE tgrelid = to_regclass('public.lltouch_cm_universal_checkout_snapshots')
        AND tgname = 'll_cm_universal_snapshot_immutable_trg' AND tgenabled IN ('O','A')
    )
  )
  SELECT jsonb_build_object('missing', COALESCE(jsonb_agg(DISTINCT component ORDER BY component), '[]'::jsonb))
  FROM missing;
$fn$;

CREATE FUNCTION public.lltouch_cm_commercial_metrics_v1(p_campaign_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH mapped AS (
    SELECT h.state AS hold_state, h.expires_at, h.quote_snapshot->>'leadId' AS lead_id,
           i.session_id, i.state AS issue_state, i.paid_at,
           b.state AS booking_state, b.started_at AS booking_started_at
    FROM public.lltouch_cm_universal_holds h
    LEFT JOIN public.lltouch_cm_mapped_issue_v1 i ON i.hold_id = h.id
    LEFT JOIN public.lltouch_cm_mapped_booking_v1 b ON b.hold_id = h.id
    WHERE h.campaign_id = p_campaign_id AND h.quote_snapshot->>'mode' = 'mapped-service-v1'
  ), crm AS (
    SELECT count(DISTINCT o.ghl_contact_id) FILTER (WHERE o.state = 'sent') AS synced,
           count(*) FILTER (WHERE o.state = 'failed') AS failed,
           count(*) FILTER (WHERE o.reconciliation_required IS TRUE) AS review
    FROM public.lltouch_cm_lead_outbox o JOIN public.lltouch_cm_leads l ON l.id = o.lead_id
    WHERE l.campaign_id = p_campaign_id AND o.campaign_key = l.campaign_key
  )
  SELECT jsonb_build_object(
    'leadsCaptured', (SELECT count(*) FROM public.lltouch_cm_leads WHERE campaign_id = p_campaign_id),
    'contactsSynced', (SELECT synced FROM crm),
    'reservationsStarted', count(*),
    'checkoutsStarted', count(*) FILTER (WHERE session_id IS NOT NULL),
    'depositsPaid', count(*) FILTER (WHERE paid_at IS NOT NULL),
    'bookingsConfirmed', NULL::integer,
    'conversions', count(DISTINCT lead_id) FILTER (WHERE paid_at IS NOT NULL),
    'expiredReservations', count(*) FILTER (WHERE hold_state = 'expired'
      OR (hold_state = 'held' AND expires_at <= statement_timestamp())),
    'integrationFailures', (SELECT failed FROM crm),
    'reconciliationPending', (SELECT review FROM crm) + count(*) FILTER (WHERE hold_state = 'review' OR issue_state = 'review'
      OR (hold_state = 'checkout' AND issue_state = 'issuing' AND expires_at <= statement_timestamp())
      OR booking_state = 'review' OR (booking_state = 'processing' AND booking_started_at <= statement_timestamp() - interval '10 minutes')),
    'calendarBlocks', count(*) FILTER (WHERE booking_state = 'calendar_verified')
  ) FROM mapped;
$fn$;

REVOKE ALL ON FUNCTION public.lltouch_cm_commercial_dependencies_v1(), public.lltouch_cm_commercial_metrics_v1(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lltouch_cm_commercial_dependencies_v1(), public.lltouch_cm_commercial_metrics_v1(uuid)
  TO service_role;
COMMIT;
