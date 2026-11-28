-- Stop the Campaign Studio CRM workers and review in-flight checkpoints before
-- applying this rollback. Keep the outbox and audit records for reconciliation.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.lltouch_cm_commercial_ghl_begin_effect_v1(text,integer,uuid,uuid,text,text);
COMMIT;
