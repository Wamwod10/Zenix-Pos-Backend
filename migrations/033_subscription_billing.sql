-- Additive and repeatable. Run only through the migration runner on staging first.
-- Do not relabel legacy payments or infer credit from a nominal tariff.
SET LOCAL lock_timeout='5s';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_code text CHECK(plan_code IN ('START','BUSINESS','PREMIUM'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS pricing_version integer NOT NULL DEFAULT 1 CHECK(pricing_version>0);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_version bigint NOT NULL DEFAULT 0 CHECK(subscription_version>=0);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_credit numeric(18,2) NOT NULL DEFAULT 0 CHECK(subscription_credit>=0 AND subscription_credit NOT IN ('NaN'::numeric,'Infinity'::numeric));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_pending_plan text CHECK(subscription_pending_plan IN ('START','BUSINESS','PREMIUM'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_change_on date;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS legacy_store_bonus integer NOT NULL DEFAULT 0 CHECK(legacy_store_bonus>=0);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='organizations' AND column_name='legacy_expiry_date') THEN
    ALTER TABLE organizations ADD COLUMN legacy_expiry_date date;
    UPDATE organizations SET legacy_expiry_date=expiry_date WHERE plan_code IS NULL;
  END IF;
END $$;

-- Immutable snapshots: new pricing requires a new version, never an UPDATE.
CREATE TABLE IF NOT EXISTS subscription_plan_versions (
  plan_code text NOT NULL,
  version integer NOT NULL,
  monthly_amount numeric(18,2) NOT NULL CHECK(monthly_amount>0),
  annual_amount numeric(18,2) NOT NULL CHECK(annual_amount>0),
  limits jsonb NOT NULL,
  PRIMARY KEY(plan_code,version)
);
INSERT INTO subscription_plan_versions(plan_code,version,monthly_amount,annual_amount,limits) VALUES
 ('START',1,250000,2500000,'{"employees":2,"stores":1,"warehouses":1,"registers":1,"products":750,"customers":500,"aiRequests":0}'),
 ('BUSINESS',1,350000,3300000,'{"employees":7,"stores":2,"warehouses":3,"registers":3,"products":10000,"customers":null,"aiRequests":100}'),
 ('PREMIUM',1,590000,5900000,'{"employees":25,"stores":10,"warehouses":15,"registers":10,"products":null,"customers":null,"aiRequests":500}')
 ON CONFLICT(plan_code,version) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscription_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL UNIQUE,
  plan_code text NOT NULL CHECK(plan_code IN ('START','BUSINESS','PREMIUM')),
  pricing_version integer NOT NULL CHECK(pricing_version>0),
  billing_interval text NOT NULL CHECK(billing_interval IN ('MONTHLY','ANNUAL')),
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK(ends_on>starts_on),
  value_amount numeric(18,2) NOT NULL CHECK(value_amount>=0 AND value_amount NOT IN ('NaN'::numeric,'Infinity'::numeric)),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_terms_payment_tenant_fk FOREIGN KEY(organization_id,payment_id) REFERENCES billing_payments(organization_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS subscription_terms_active_idx ON subscription_terms(organization_id,starts_on,ends_on) WHERE superseded_at IS NULL;
CREATE TABLE IF NOT EXISTS subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL CHECK(event_type IN ('ACTIVATE','RENEW','UPGRADE')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_events_payment_tenant_fk FOREIGN KEY(organization_id,payment_id) REFERENCES billing_payments(organization_id,id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION subscription_effective_plan(org uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT COALESCE(
   CASE WHEN o.subscription_change_on <= (statement_timestamp() AT TIME ZONE 'Asia/Tashkent')::date THEN o.subscription_pending_plan END,
   (SELECT t.plan_code FROM subscription_terms t WHERE t.organization_id=o.id AND t.superseded_at IS NULL
    AND t.starts_on <= (statement_timestamp() AT TIME ZONE 'Asia/Tashkent')::date AND t.ends_on > (statement_timestamp() AT TIME ZONE 'Asia/Tashkent')::date ORDER BY t.starts_on DESC,t.id LIMIT 1),
   o.plan_code,'BUSINESS') FROM organizations o WHERE o.id=org
$$;
CREATE OR REPLACE FUNCTION subscription_period_valid(org uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE o organizations; day date:=(clock_timestamp() AT TIME ZONE 'Asia/Tashkent')::date;
BEGIN
 SELECT * INTO o FROM organizations WHERE id=org;
 IF NOT FOUND THEN RETURN false; END IF;
 IF NULLIF(o.settings->>'trialEndsAt','') IS NOT NULL THEN RETURN (o.settings->>'trialEndsAt')::timestamptz>clock_timestamp(); END IF;
 IF EXISTS(SELECT 1 FROM subscription_terms WHERE organization_id=org AND superseded_at IS NULL) THEN
   RETURN EXISTS(SELECT 1 FROM subscription_terms WHERE organization_id=org AND superseded_at IS NULL AND starts_on<=day AND ends_on>day)
     OR COALESCE(o.legacy_expiry_date >= (clock_timestamp() AT TIME ZONE o.timezone)::date,false);
 END IF;
 RETURN o.expiry_date IS NULL OR o.expiry_date >= (clock_timestamp() AT TIME ZONE o.timezone)::date;
END $$;
CREATE OR REPLACE FUNCTION subscription_can_write(org uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(o.license_status IN ('ACTIVE','APPROVED') AND COALESCE(o.settings->>'billingHold','false')<>'true'
   AND subscription_period_valid(o.id),false) FROM organizations o WHERE o.id=org
$$;

CREATE OR REPLACE FUNCTION guard_subscription_business_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; org uuid; old_org uuid; writable boolean; cap integer; used bigint;
BEGIN
 IF TG_TABLE_NAME='users' AND TG_OP='UPDATE' AND
   (to_jsonb(NEW)-ARRAY['password_hash','must_change_password','updated_at'])=(to_jsonb(OLD)-ARRAY['password_hash','must_change_password','updated_at']) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='organizations' AND TG_OP='UPDATE' THEN
  IF
   (NEW.name,NEW.phone,NEW.address,NEW.timezone,NEW.currency,NEW.settings->'workspaceSettings',NEW.settings->'businessFeatures',NEW.settings->'rolePermissions',NEW.settings->'customerTags')
   IS NOT DISTINCT FROM
   (OLD.name,OLD.phone,OLD.address,OLD.timezone,OLD.currency,OLD.settings->'workspaceSettings',OLD.settings->'businessFeatures',OLD.settings->'rolePermissions',OLD.settings->'customerTags') THEN RETURN NEW; END IF;
 END IF;
 data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='organizations' THEN org:=(data->>'id')::uuid;
 ELSIF data ? 'organization_id' THEN org:=(data->>'organization_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('sale_items','sale_payments') THEN SELECT organization_id INTO org FROM sales WHERE id=(data->>'sale_id')::uuid;
 ELSIF TG_TABLE_NAME='supplier_invoice_items' THEN SELECT organization_id INTO org FROM supplier_invoices WHERE id=(data->>'invoice_id')::uuid;
 ELSIF TG_TABLE_NAME='stock_transfer_items' THEN SELECT organization_id INTO org FROM stock_transfers WHERE id=(data->>'transfer_id')::uuid;
 ELSE RAISE EXCEPTION 'Unknown subscription write scope' USING ERRCODE='ZX403'; END IF;
 IF org IS NULL AND TG_TABLE_NAME='users' AND data->>'app_role'='PLATFORM_ADMIN' THEN RETURN COALESCE(NEW,OLD); END IF;
 IF org IS NULL THEN RAISE EXCEPTION 'Missing organization' USING ERRCODE='ZX403'; END IF;
 -- Lock before checking: expiry/suspension and billing approval share this lock.
 PERFORM id FROM organizations WHERE id=org FOR UPDATE;
 IF TG_OP='UPDATE' AND to_jsonb(OLD) ? 'organization_id' THEN
   old_org:=(to_jsonb(OLD)->>'organization_id')::uuid;
   IF old_org IS DISTINCT FROM org THEN RAISE EXCEPTION 'Organization identity is immutable' USING ERRCODE='ZX403'; END IF;
 END IF;
 IF current_setting('zenix.registration_organization',true)=org::text AND EXISTS(SELECT 1 FROM organizations WHERE id=org AND created_at>=transaction_timestamp()) THEN RETURN COALESCE(NEW,OLD); END IF;
 writable:=subscription_can_write(org);
 IF writable IS DISTINCT FROM true THEN RAISE EXCEPTION 'Business is read-only' USING ERRCODE='ZX402'; END IF;
 -- Count the entire stored catalogue, including archived products. No silent deletion.
 IF TG_TABLE_NAME='products' AND TG_OP='INSERT' AND EXISTS(SELECT 1 FROM organizations WHERE id=org AND plan_code IS NOT NULL) THEN
   SELECT (p.limits->>'products')::integer INTO cap FROM subscription_plan_versions p JOIN organizations o ON o.pricing_version=p.version
     WHERE o.id=org AND p.plan_code=subscription_effective_plan(org);
   IF NOT FOUND THEN RAISE EXCEPTION 'Unknown subscription pricing version' USING ERRCODE='ZX403'; END IF;
   IF cap IS NOT NULL THEN SELECT count(*) INTO used FROM products WHERE organization_id=org;
     IF used>=cap THEN RAISE EXCEPTION 'Product limit reached' USING ERRCODE='ZX409'; END IF;
   END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['stores','users','products','inventory_balances','warehouse_balances','warehouses','inventory_batches','product_serials','stock_movements','shifts','shift_movements','sales','sale_items','sale_payments','sale_returns','suppliers','supplier_invoices','supplier_invoice_items','supplier_payments','expenses','stock_transfers','stock_transfer_items','inventory_counts','sale_holds','business_days','customers','customer_ledger','customer_payment_allocations','customer_loyalty_ledger','file_assets','telegram_link_tokens','telegram_connections'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS subscription_business_write_guard ON %I',name);
   EXECUTE format('CREATE TRIGGER subscription_business_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_subscription_business_write()',name);
 END LOOP;
 DROP TRIGGER IF EXISTS subscription_business_write_guard ON organizations;
 CREATE TRIGGER subscription_business_write_guard BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION guard_subscription_business_write();
END $$;
