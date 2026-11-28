-- Read-only consistency assertions and aggregate reconciliation counts.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';

DO $verify$
BEGIN
  IF EXISTS (
    SELECT FROM public.lltouch_campaigns c
    LEFT JOIN public.lltouch_cm_commercial_authorization_v1 a ON a.campaign_id = c.id
    WHERE (c.marketing #> '{campaignMeta,mappedReservationAuthorized}' = 'true'::jsonb OR
           c.marketing #> '{campaignMeta,mappedCheckoutAuthorized}' = 'true'::jsonb)
      AND (a.state IS DISTINCT FROM 'activated' OR a.campaign_version IS DISTINCT FROM c.version
           OR a.campaign_status IS DISTINCT FROM 'published' OR c.status <> 'published'
           OR c.marketing #> '{campaignMeta,mappedReservationAuthorized}' IS DISTINCT FROM 'true'::jsonb
           OR c.marketing #> '{campaignMeta,mappedCheckoutAuthorized}' IS DISTINCT FROM 'true'::jsonb)
  ) THEN
    RAISE EXCEPTION 'CM_PREVIEW_UNTRACKED_OR_INCONSISTENT_MAPPED_RELEASE';
  END IF;

  IF EXISTS (
    SELECT FROM public.lltouch_cm_commercial_authorization_v1 a
    LEFT JOIN public.lltouch_cm_commercial_audit_v1 h ON h.campaign_id = a.campaign_id AND h.revision = a.revision
    WHERE h.campaign_id IS NULL
  ) THEN
    RAISE EXCEPTION 'CM_PREVIEW_AUTHORIZATION_AUDIT_MISSING';
  END IF;

  IF EXISTS (
    SELECT FROM public.lltouch_cm_lead_capture_settings s
    JOIN public.lltouch_campaigns c ON c.campaign_key = s.campaign_key
    JOIN public.lltouch_cm_commercial_authorization_v1 a ON a.campaign_id = c.id
    WHERE s.enabled AND (a.state <> 'activated' OR c.status <> 'published'
      OR a.campaign_version <> c.version OR s.campaign_version <> c.version)
  ) THEN
    RAISE EXCEPTION 'CM_PREVIEW_CAPTURE_FLAG_WITHOUT_APPROVAL';
  END IF;

  IF EXISTS (
    SELECT FROM public.lltouch_cm_commercial_authorization_v1 a
    JOIN public.lltouch_campaigns c ON c.id = a.campaign_id
    LEFT JOIN public.lltouch_cm_lead_capture_settings s ON s.campaign_key = c.campaign_key
    WHERE a.state = 'activated' AND (c.status <> 'published' OR a.campaign_version <> c.version
      OR s.enabled IS DISTINCT FROM true OR s.campaign_version IS DISTINCT FROM c.version
      OR c.marketing #> '{campaignMeta,mappedReservationAuthorized}' IS DISTINCT FROM 'true'::jsonb
      OR c.marketing #> '{campaignMeta,mappedCheckoutAuthorized}' IS DISTINCT FROM 'true'::jsonb)
  ) THEN
    RAISE EXCEPTION 'CM_PREVIEW_ACTIVATED_BINDING_INCOMPLETE';
  END IF;
END
$verify$;

SELECT 'VERIFIED' AS db_consistency,
       (SELECT count(*) FROM public.lltouch_campaigns WHERE status = 'published') AS published,
       (SELECT count(*) FROM public.lltouch_cm_commercial_authorization_v1) AS authorizations,
       (SELECT count(*) FROM public.lltouch_cm_commercial_audit_v1) AS audit_events,
       (SELECT count(*) FROM public.lltouch_cm_universal_holds
          WHERE quote_snapshot->>'mode' = 'mapped-service-v1' AND state IN ('checkout','paid','processing','review')) AS holds_to_review_or_drain,
       (SELECT count(*) FROM public.lltouch_cm_mapped_issue_v1 WHERE state IN ('issuing','bound','review')) AS checkout_to_review_or_drain,
       (SELECT count(*) FROM public.lltouch_cm_mapped_booking_v1 WHERE state IN ('processing','review')) AS bookings_to_review_or_drain,
       (SELECT count(*) FROM public.lltouch_cm_lead_outbox
          WHERE state = 'sending' OR reconciliation_required) AS crm_to_review_or_drain;

COMMIT;
