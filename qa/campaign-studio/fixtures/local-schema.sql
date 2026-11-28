-- Synthetic prerequisites for the disposable PostgreSQL campaign tests.
DO $fixture$
BEGIN
  IF current_database() !~ '^lltouch_[a-z]+_qa$' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Use a disposable lltouch_*_qa database over a local Unix socket';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$fixture$;

CREATE EXTENSION btree_gist;

CREATE TABLE public.lltouch_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_key text NOT NULL UNIQUE,
  version integer NOT NULL,
  status text NOT NULL,
  site_item jsonb NOT NULL,
  service_title text NOT NULL,
  marketing jsonb NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  regular_price_cents integer NOT NULL,
  price_cents integer NOT NULL,
  deposit_cents integer NOT NULL,
  hold_minutes integer NOT NULL DEFAULT 10,
  timezone text NOT NULL DEFAULT 'America/New_York',
  offer_starts_at timestamptz NOT NULL,
  offer_ends_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.lltouch_campaign_assets (
  campaign_id uuid NOT NULL REFERENCES public.lltouch_campaigns(id),
  asset_type text NOT NULL,
  device text NOT NULL,
  position integer NOT NULL,
  image_url text NOT NULL,
  PRIMARY KEY (campaign_id, asset_type, device, position)
);

CREATE TABLE public.lltouch_cm_lead_capture_settings (
  campaign_id uuid PRIMARY KEY REFERENCES public.lltouch_campaigns(id),
  campaign_key text NOT NULL UNIQUE,
  campaign_version integer NOT NULL,
  enabled boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.lltouch_cm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.lltouch_campaigns(id),
  campaign_key text NOT NULL,
  campaign_version integer NOT NULL,
  client_nonce uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text NOT NULL,
  contact_consent boolean NOT NULL,
  sms_marketing_consent boolean NOT NULL,
  quote_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id, client_nonce)
);

CREATE TABLE public.lltouch_cm_universal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.lltouch_campaigns(id),
  campaign_key text NOT NULL,
  campaign_version integer NOT NULL,
  client_nonce uuid NOT NULL,
  state text NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text NOT NULL,
  contact_consent boolean NOT NULL,
  sms_marketing_consent boolean NOT NULL,
  treatment_area_key text NOT NULL,
  booking_mode text NOT NULL,
  provider_key text NOT NULL,
  requested_date date NOT NULL,
  requested_time time NOT NULL,
  appointment_start timestamptz NOT NULL,
  appointment_end timestamptz NOT NULL,
  quote_snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  stripe_session_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id, client_nonce),
  CONSTRAINT llt_cm_active_provider_overlap_excl EXCLUDE USING gist (
    provider_key WITH =, tstzrange(appointment_start, appointment_end, '[)') WITH &&
  ) WHERE (state IN ('held','checkout','paid','processing','confirmed','review'))
);

CREATE TABLE public.lltouch_cm_universal_checkout_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id uuid NOT NULL UNIQUE REFERENCES public.lltouch_cm_universal_holds(id),
  campaign_id uuid NOT NULL REFERENCES public.lltouch_campaigns(id),
  campaign_key text NOT NULL,
  campaign_version integer NOT NULL,
  currency text NOT NULL,
  price_cents integer NOT NULL,
  deposit_cents integer NOT NULL,
  sessions integer NOT NULL,
  booking_mode text NOT NULL,
  treatment_area_key text NOT NULL,
  immutable_terms jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION public.lltouch_qa_reject_snapshot_edits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Fixture checkout snapshots are immutable';
END
$$;

CREATE TRIGGER ll_cm_universal_snapshot_immutable_trg
BEFORE UPDATE OR DELETE ON public.lltouch_cm_universal_checkout_snapshots
FOR EACH ROW EXECUTE FUNCTION public.lltouch_qa_reject_snapshot_edits();

CREATE TABLE public.lltouch_offer_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  state text NOT NULL,
  hold_expires_at timestamptz
);

CREATE TABLE public.lltouch_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  service_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL,
  stripe_session_id text,
  paid_total_cents integer,
  google_event_id text,
  vagaro_appointment_id text
);

CREATE TABLE public.lltouch_cm_lead_outbox (
  lead_id uuid PRIMARY KEY REFERENCES public.lltouch_cm_leads(id),
  campaign_id uuid REFERENCES public.lltouch_campaigns(id),
  campaign_key text NOT NULL,
  campaign_version integer NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  external_step text NOT NULL DEFAULT 'none',
  reconciliation_required boolean NOT NULL DEFAULT false,
  ghl_contact_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Compatibility shims replace the legacy migrations that are absent from this checkout.
CREATE FUNCTION public.lltouch_cm_display_release(p_campaign_key text, p_expected_version integer, p_action text)
RETURNS TABLE(campaign_key text, new_version integer, new_status text)
LANGUAGE sql AS $$
  UPDATE public.lltouch_campaigns c
  SET version=c.version+1, status=CASE p_action WHEN 'publish_display' THEN 'published' WHEN 'pause' THEN 'paused' ELSE 'draft' END
  WHERE c.campaign_key=p_campaign_key AND c.version=p_expected_version
  RETURNING c.campaign_key,c.version,c.status;
$$;

CREATE FUNCTION public.lltouch_cm_lead_capture_configure(p_campaign_key text, p_expected_version integer, p_enabled boolean)
RETURNS jsonb LANGUAGE sql AS $$
  INSERT INTO public.lltouch_cm_lead_capture_settings(campaign_id,campaign_key,campaign_version,enabled)
  SELECT c.id,c.campaign_key,c.version,p_enabled FROM public.lltouch_campaigns c
  WHERE c.campaign_key=p_campaign_key AND c.version=p_expected_version
  ON CONFLICT (campaign_id) DO UPDATE SET campaign_version=EXCLUDED.campaign_version,enabled=EXCLUDED.enabled
  RETURNING jsonb_build_object('ok',true,'campaignVersion',campaign_version,'enabled',enabled);
$$;

CREATE FUNCTION public.lltouch_cm_ghl_effect_checkpoint(
  p_lead_id uuid, p_lease_token uuid, p_expected_step text, p_next_step text
) RETURNS boolean LANGUAGE sql AS $$
  WITH changed AS (
    UPDATE public.lltouch_cm_lead_outbox SET external_step=p_next_step,updated_at=clock_timestamp()
    WHERE lead_id=p_lead_id AND lease_token=p_lease_token AND lease_expires_at>clock_timestamp()
      AND state='sending' AND external_step=p_expected_step
    RETURNING lead_id
  ) SELECT EXISTS (SELECT FROM changed);
$$;

CREATE FUNCTION public.lltouch_cm_lead_capture_submit(
  p_campaign_key text, p_campaign_version integer, p_client_nonce uuid, p_customer_name text,
  p_customer_email text, p_customer_phone text, p_contact_consent boolean, p_sms_marketing_consent boolean
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_campaign public.lltouch_campaigns;
  v_id uuid;
  v_idempotent boolean;
BEGIN
  SELECT * INTO STRICT v_campaign FROM public.lltouch_campaigns c
  WHERE c.campaign_key=p_campaign_key AND c.version=p_campaign_version;
  INSERT INTO public.lltouch_cm_leads(campaign_id,campaign_key,campaign_version,client_nonce,customer_name,customer_email,
    customer_phone,contact_consent,sms_marketing_consent,quote_snapshot)
  VALUES (v_campaign.id,p_campaign_key,p_campaign_version,p_client_nonce,p_customer_name,p_customer_email,p_customer_phone,
    p_contact_consent,p_sms_marketing_consent,jsonb_build_object('priceCents',v_campaign.price_cents,
      'regularPriceCents',v_campaign.regular_price_cents,'depositCents',v_campaign.deposit_cents,
      'currency',v_campaign.currency,'sourceCampaignVersion',v_campaign.version))
  ON CONFLICT (campaign_id,client_nonce) DO NOTHING RETURNING id INTO v_id;
  v_idempotent := NOT FOUND;
  IF v_idempotent THEN
    SELECT l.id INTO STRICT v_id FROM public.lltouch_cm_leads l
    WHERE l.campaign_id=v_campaign.id AND l.client_nonce=p_client_nonce;
  END IF;
  RETURN jsonb_build_object('ok',true,'leadId',v_id,'idempotent',v_idempotent,
    'contactOnly',true,'bookingReady',false,'checkoutReady',false);
END
$$;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
REVOKE EXECUTE ON FUNCTION public.lltouch_cm_display_release(text,integer,text),
  public.lltouch_cm_lead_capture_configure(text,integer,boolean),
  public.lltouch_cm_lead_capture_submit(text,integer,uuid,text,text,text,boolean,boolean),
  public.lltouch_cm_ghl_effect_checkpoint(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lltouch_cm_display_release(text,integer,text),
  public.lltouch_cm_lead_capture_configure(text,integer,boolean),
  public.lltouch_cm_lead_capture_submit(text,integer,uuid,text,text,text,boolean,boolean),
  public.lltouch_cm_ghl_effect_checkpoint(uuid,uuid,text,text)
  TO service_role;
