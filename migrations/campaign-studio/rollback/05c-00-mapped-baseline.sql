-- Schema rollback for an unused installation. Stop sales and workers first.
-- Roll back dependent 05C migrations before this script. Keep all ledgers if
-- any mapped activity exists and use the operational rollback procedure.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.lltouch_campaigns, public.lltouch_cm_universal_holds,
  public.lltouch_cm_universal_checkout_snapshots, public.lltouch_cm_mapped_issue_v1,
  public.lltouch_cm_mapped_event_v1, public.lltouch_cm_mapped_booking_v1 IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF to_regprocedure('public.lltouch_cm_commercial_lifecycle_v1(text,integer,integer,text,text,jsonb,timestamptz)') IS NOT NULL
     OR to_regprocedure('public.lltouch_cm_commercial_metrics_v1(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'CM_MAPPED_BASELINE_ROLLBACK_DEPENDENT_MIGRATIONS_PRESENT';
  END IF;
  IF EXISTS (SELECT FROM public.lltouch_campaigns WHERE
      marketing #> '{campaignMeta,mappedReservationAuthorized}' = 'true'::jsonb
      OR marketing #> '{campaignMeta,mappedCheckoutAuthorized}' = 'true'::jsonb) THEN
    RAISE EXCEPTION 'CM_MAPPED_BASELINE_ROLLBACK_AUTHORIZATION_PRESENT';
  END IF;
  IF EXISTS (SELECT FROM public.lltouch_cm_universal_holds WHERE quote_snapshot->>'mode' = 'mapped-service-v1')
     OR EXISTS (SELECT FROM public.lltouch_cm_universal_checkout_snapshots WHERE immutable_terms->>'mode' = 'mapped-service-v1')
     OR EXISTS (SELECT FROM public.lltouch_cm_mapped_issue_v1)
     OR EXISTS (SELECT FROM public.lltouch_cm_mapped_event_v1)
     OR EXISTS (SELECT FROM public.lltouch_cm_mapped_booking_v1) THEN
    RAISE EXCEPTION 'CM_MAPPED_BASELINE_ROLLBACK_WOULD_REMOVE_HISTORY';
  END IF;
END
$guard$;

DROP FUNCTION public.lltouch_cm_mapped_booking_finish_v1(uuid,uuid,uuid,text);
DROP FUNCTION public.lltouch_cm_mapped_booking_claim_v1();
DROP FUNCTION public.lltouch_cm_mapped_poll_result_v1(uuid,uuid,text,text,text,timestamptz);
DROP FUNCTION public.lltouch_cm_mapped_due_issues_v1();
DROP FUNCTION public.lltouch_cm_mapped_issue_event_v1(uuid,uuid,text,text,text,text,timestamptz);
DROP FUNCTION public.lltouch_cm_mapped_issue_bind_v1(uuid,uuid,text);
DROP FUNCTION public.lltouch_cm_mapped_issue_begin_v1(uuid,uuid,uuid,uuid);
DROP FUNCTION public.lltouch_cm_mapped_reserve_v1(text,integer,uuid,uuid,text,text,text,timestamptz);
DROP TABLE public.lltouch_cm_mapped_booking_v1, public.lltouch_cm_mapped_event_v1, public.lltouch_cm_mapped_issue_v1;

COMMIT;
