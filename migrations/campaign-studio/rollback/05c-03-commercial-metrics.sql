BEGIN;
SET LOCAL lock_timeout = '5s';
DROP FUNCTION public.lltouch_cm_commercial_dependencies_v1(), public.lltouch_cm_commercial_metrics_v1(uuid);
COMMIT;
