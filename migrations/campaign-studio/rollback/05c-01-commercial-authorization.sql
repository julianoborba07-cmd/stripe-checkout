-- Schema rollback for an unused installation only. Remove dependent 05C
-- migrations first. For a used installation disable application gates and
-- revoke/pause via the lifecycle API to retain approvals and their audit trail.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.lltouch_campaigns, public.lltouch_campaign_assets, public.lltouch_cm_lead_capture_settings,
  public.lltouch_cm_leads, public.lltouch_cm_commercial_authorization_v1, public.lltouch_cm_commercial_audit_v1
  IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF EXISTS (SELECT FROM public.lltouch_cm_commercial_authorization_v1) OR
     EXISTS (SELECT FROM public.lltouch_cm_commercial_audit_v1) THEN
    RAISE EXCEPTION 'CM_COMMERCIAL_ROLLBACK_WOULD_REMOVE_AUDIT';
  END IF;
END;
$guard$;

DROP FUNCTION public.lltouch_cm_commercial_submit_v1(text,integer,uuid,text,text,text,boolean,boolean);
DROP FUNCTION public.lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz);
DROP TRIGGER lltouch_cm_commercial_lead_guard_v1 ON public.lltouch_cm_leads;
DROP TRIGGER lltouch_cm_commercial_capture_setting_guard_v1 ON public.lltouch_cm_lead_capture_settings;
DROP TRIGGER lltouch_cm_commercial_asset_guard_v1 ON public.lltouch_campaign_assets;
DROP TRIGGER lltouch_cm_commercial_campaign_guard_v1 ON public.lltouch_campaigns;
DROP FUNCTION public.lltouch_cm_commercial_lead_guard_v1(), public.lltouch_cm_commercial_capture_setting_guard_v1(),
  public.lltouch_cm_commercial_asset_guard_v1(), public.lltouch_cm_commercial_campaign_guard_v1();
DROP FUNCTION public.lltouch_cm_commercial_status_v1(text);
DROP FUNCTION public.lltouch_cm_commercial_review_token_v1(public.lltouch_campaigns);
DROP FUNCTION public.lltouch_cm_commercial_active_v1(uuid,integer), public.lltouch_cm_commercial_assert_plan_v1(public.lltouch_campaigns),
  public.lltouch_cm_commercial_material_v1(public.lltouch_campaigns), public.lltouch_cm_commercial_invalidate_v1(public.lltouch_campaigns,text,integer),
  public.lltouch_cm_commercial_disable_capture_v1(text);
DROP TABLE public.lltouch_cm_commercial_audit_v1, public.lltouch_cm_commercial_authorization_v1;

COMMIT;
