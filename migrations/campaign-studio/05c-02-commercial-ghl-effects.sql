-- Candidate migration. Apply only after the versioned commercial lifecycle
-- and the existing Campaign Studio GHL outbox/checkpoint schema are in place.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $prerequisites$
BEGIN
  IF to_regprocedure('public.lltouch_cm_commercial_active_v1(uuid,integer)') IS NULL
     OR to_regprocedure('public.lltouch_cm_ghl_effect_checkpoint(uuid,uuid,text,text)') IS NULL
     OR to_regclass('public.lltouch_cm_leads') IS NULL
     OR to_regclass('public.lltouch_cm_lead_outbox') IS NULL THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_GHL_SCHEMA_MISSING';
  END IF;
END;
$prerequisites$;

CREATE FUNCTION public.lltouch_cm_commercial_ghl_begin_effect_v1(
  p_campaign_key text,
  p_expected_version integer,
  p_lead_id uuid,
  p_lease_token uuid,
  p_expected_step text,
  p_next_step text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $effect$
DECLARE
  target_campaign_id uuid;
BEGIN
  IF p_campaign_key IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_lead_id IS NULL OR p_lease_token IS NULL
     OR p_expected_step IS NULL OR p_next_step IS NULL
     OR (p_expected_step, p_next_step) NOT IN (
       ('none', 'upsert_started'),
       ('upsert_recorded', 'lead_tag_started'),
       ('lead_tag_recorded', 'service_tag_started')
     ) THEN
    RETURN false;
  END IF;

  -- Use the same campaign row lock as the lifecycle mutation. Revocation
  -- prevents subsequent external effect authorizations; a durable start that
  -- committed first must still be acknowledged or manually reconciled.
  SELECT c.id INTO target_campaign_id
    FROM public.lltouch_campaigns c
    WHERE c.campaign_key = p_campaign_key AND c.version = p_expected_version
    FOR SHARE;
  IF NOT FOUND OR public.lltouch_cm_commercial_active_v1(target_campaign_id, p_expected_version) IS DISTINCT FROM true THEN
    RETURN false;
  END IF;
  PERFORM FROM public.lltouch_cm_leads l
  WHERE l.id = p_lead_id AND l.campaign_id = target_campaign_id
    AND l.campaign_key = p_campaign_key AND l.campaign_version = p_expected_version
    AND l.contact_consent IS TRUE
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Lock the leased checkpoint before using it. The legacy RPC remains the
  -- authority for lease expiration and writes the durable transition.
  PERFORM FROM public.lltouch_cm_lead_outbox o
  WHERE o.lead_id = p_lead_id AND o.campaign_key = p_campaign_key
    AND o.lease_token = p_lease_token AND o.state = 'sending'
    AND o.external_step::text = p_expected_step AND o.reconciliation_required IS FALSE
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  RETURN public.lltouch_cm_ghl_effect_checkpoint(
    p_lead_id, p_lease_token, p_expected_step, p_next_step
  );
END;
$effect$;

REVOKE EXECUTE ON FUNCTION public.lltouch_cm_commercial_ghl_begin_effect_v1(text,integer,uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lltouch_cm_commercial_ghl_begin_effect_v1(text,integer,uuid,uuid,text,text)
  TO service_role;
COMMIT;
