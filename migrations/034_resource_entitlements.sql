-- Additive resource enforcement; preserve applied 001–033 checksums and history.
SET LOCAL lock_timeout='5s';
LOCK TABLE shifts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
CREATE TABLE IF NOT EXISTS pos_registers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 store_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 120),
 register_key text NOT NULL,
 is_default boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,store_id,id),
 UNIQUE(organization_id,store_id,register_key),
 CONSTRAINT pos_registers_store_tenant_fk FOREIGN KEY(organization_id,store_id) REFERENCES stores(organization_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_registers_default_unique ON pos_registers(organization_id,store_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS pos_registers_active_idx ON pos_registers(organization_id) WHERE active;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS register_id uuid;
-- Backfill only when the registry is first introduced. Existing over-limit tenants
-- retain their workplaces and shift IDs; no financial quantities are rewritten.
INSERT INTO pos_registers(organization_id,store_id,name,register_key,is_default,created_at)
 SELECT organization_id,store_id,'POS '||left(register_key,100),register_key,position=1,first_opened
 FROM (SELECT organization_id,store_id,register_key,min(opened_at) first_opened,
   row_number() OVER(PARTITION BY organization_id,store_id ORDER BY
    CASE WHEN register_key='store:'||store_id::text THEN 0 ELSE 1 END,min(opened_at),register_key) position
   FROM shifts GROUP BY organization_id,store_id,register_key) old
 WHERE NOT EXISTS(SELECT 1 FROM pos_registers p WHERE p.organization_id=old.organization_id AND p.store_id=old.store_id)
 ON CONFLICT(organization_id,store_id,register_key) DO NOTHING;
ALTER TABLE shifts DISABLE TRIGGER subscription_business_write_guard;
UPDATE shifts s SET register_id=p.id FROM pos_registers p
 WHERE s.register_id IS NULL AND p.organization_id=s.organization_id AND p.store_id=s.store_id AND p.register_key=s.register_key;
ALTER TABLE shifts ENABLE TRIGGER subscription_business_write_guard;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='shifts'::regclass AND conname='shifts_register_tenant_fk') THEN
  ALTER TABLE shifts ADD CONSTRAINT shifts_register_tenant_fk FOREIGN KEY(organization_id,store_id,register_id)
   REFERENCES pos_registers(organization_id,store_id,id) ON DELETE RESTRICT;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION resource_entitlement(org uuid,resource text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE o organizations; code text; price_version integer; cap integer; used bigint; day date:=(clock_timestamp() AT TIME ZONE 'Asia/Tashkent')::date;
BEGIN
 SELECT * INTO o FROM organizations WHERE id=org;
 IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE='ZX403'; END IF;
 SELECT t.plan_code,t.pricing_version INTO code,price_version FROM subscription_terms t WHERE t.organization_id=org AND t.superseded_at IS NULL AND t.starts_on<=day AND t.ends_on>day ORDER BY t.starts_on DESC,t.id LIMIT 1;
 code:=COALESCE(CASE WHEN o.subscription_change_on<=day THEN o.subscription_pending_plan END,code,o.plan_code,'BUSINESS');
 price_version:=COALESCE(price_version,o.pricing_version);
 SELECT (limits->>resource)::integer INTO cap FROM subscription_plan_versions WHERE plan_code=code AND version=price_version;
 IF NOT FOUND OR resource NOT IN ('employees','stores','warehouses','registers','products','customers') THEN RAISE EXCEPTION 'Unknown resource or plan version' USING ERRCODE='ZX403'; END IF;
 -- Legacy billing allowances remain valid until explicit modern tier selection.
 IF o.plan_code IS NULL THEN
  day:=(clock_timestamp() AT TIME ZONE o.timezone)::date;
  cap:=NULL;
  IF resource='stores' THEN SELECT o.store_limit+COALESCE(sum(quantity),0)::integer INTO cap FROM extra_store_entitlements WHERE organization_id=org AND starts_on<=day AND expires_on>day; END IF;
 END IF;
 CASE resource
  WHEN 'employees' THEN SELECT count(*) INTO used FROM users WHERE organization_id=org AND active AND app_role<>'OWNER';
  WHEN 'stores' THEN SELECT count(*) INTO used FROM stores WHERE organization_id=org AND (o.plan_code IS NOT NULL OR active);
  WHEN 'warehouses' THEN SELECT count(*) INTO used FROM warehouses WHERE organization_id=org;
  WHEN 'registers' THEN SELECT count(*) INTO used FROM pos_registers WHERE organization_id=org AND active;
  WHEN 'products' THEN SELECT count(*) INTO used FROM products WHERE organization_id=org;
  WHEN 'customers' THEN SELECT count(*) INTO used FROM customers WHERE organization_id=org;
 END CASE;
 RETURN jsonb_build_object('resource',resource,'planCode',code,'pricingVersion',price_version,'limit',cap,'used',used,
  'remaining',CASE WHEN cap IS NULL THEN NULL ELSE greatest(0,cap-used) END,'overLimit',CASE WHEN cap IS NULL THEN 0 ELSE greatest(0,used-cap) END,
  'upgradeRequired',cap IS NOT NULL AND used>=cap AND code<>'PREMIUM','upgradeAvailable',code<>'PREMIUM');
END $$;
CREATE OR REPLACE FUNCTION assert_resource_capacity(org uuid,resource text,increase integer DEFAULT 1) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE state jsonb; cap bigint; used bigint; tier text;
BEGIN
 IF increase IS NULL OR increase<1 OR resource IS NULL OR resource NOT IN ('employees','stores','warehouses','registers','products','customers') THEN RAISE EXCEPTION 'Invalid increase' USING ERRCODE='ZX403'; END IF;
 SELECT plan_code INTO tier FROM organizations WHERE id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE='ZX403'; END IF;
 IF tier IS NULL THEN RETURN; END IF;
  state:=resource_entitlement(org,resource);cap:=(state->>'limit')::bigint;used:=(state->>'used')::bigint;
 IF cap IS NOT NULL AND used+increase>cap THEN
  RAISE EXCEPTION 'Resource limit reached' USING ERRCODE='ZX409',DETAIL=(state||jsonb_build_object('requestedIncrease',increase))::text;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_resource_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource text; growth boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN RAISE EXCEPTION 'Organization is immutable' USING ERRCODE='ZX403'; END IF;
 CASE TG_TABLE_NAME
  WHEN 'users' THEN resource:='employees';growth:=NEW.active AND NEW.app_role<>'OWNER' AND (TG_OP='INSERT' OR NOT OLD.active OR OLD.app_role='OWNER');
  WHEN 'pos_registers' THEN resource:='registers';growth:=NEW.active AND (TG_OP='INSERT' OR NOT OLD.active);
  WHEN 'stores' THEN resource:='stores';growth:=TG_OP='INSERT';
  WHEN 'warehouses' THEN resource:='warehouses';growth:=TG_OP='INSERT';
  WHEN 'products' THEN resource:='products';growth:=TG_OP='INSERT';
  WHEN 'customers' THEN resource:='customers';growth:=TG_OP='INSERT';
  ELSE RAISE EXCEPTION 'Unknown resource' USING ERRCODE='ZX403';
 END CASE;
 IF growth AND NEW.organization_id IS NOT NULL THEN
  PERFORM assert_resource_capacity(NEW.organization_id,resource,1);
  -- stores_default_warehouse creates a counted resource in this transaction.
  IF resource='stores' THEN PERFORM assert_resource_capacity(NEW.organization_id,'warehouses',1); END IF;
 END IF;
 RETURN NEW;
END $$;

-- Preserve 033 write protection, moving product counting to the common guard.
CREATE OR REPLACE FUNCTION guard_subscription_business_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; org uuid; old_org uuid;
BEGIN
 IF TG_TABLE_NAME='users' AND TG_OP='UPDATE' AND
  (to_jsonb(NEW)-ARRAY['password_hash','must_change_password','updated_at'])=(to_jsonb(OLD)-ARRAY['password_hash','must_change_password','updated_at']) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='organizations' AND TG_OP='UPDATE' THEN
  IF (NEW.name,NEW.phone,NEW.address,NEW.timezone,NEW.currency,NEW.settings->'workspaceSettings',NEW.settings->'businessFeatures',NEW.settings->'rolePermissions',NEW.settings->'customerTags') IS NOT DISTINCT FROM
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
 PERFORM id FROM organizations WHERE id=org FOR UPDATE;
 IF TG_OP='UPDATE' AND to_jsonb(OLD) ? 'organization_id' THEN
  old_org:=(to_jsonb(OLD)->>'organization_id')::uuid;
  IF old_org IS DISTINCT FROM org THEN RAISE EXCEPTION 'Organization identity is immutable' USING ERRCODE='ZX403'; END IF;
 END IF;
 IF current_setting('zenix.registration_organization',true)=org::text AND EXISTS(SELECT 1 FROM organizations WHERE id=org AND created_at>=transaction_timestamp()) THEN RETURN COALESCE(NEW,OLD); END IF;
 IF subscription_can_write(org) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Business is read-only' USING ERRCODE='ZX402'; END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE OR REPLACE FUNCTION guard_pos_register_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM organizations WHERE id=NEW.organization_id FOR UPDATE;
 IF TG_OP='UPDATE' THEN
  IF (NEW.organization_id,NEW.store_id,NEW.register_key,NEW.is_default) IS DISTINCT FROM (OLD.organization_id,OLD.store_id,OLD.register_key,OLD.is_default) THEN RAISE EXCEPTION 'POS identity is immutable' USING ERRCODE='ZX403'; END IF;
  IF NOT NEW.active AND OLD.active AND EXISTS(SELECT 1 FROM shifts WHERE organization_id=NEW.organization_id AND register_id=NEW.id AND status='open') THEN RAISE EXCEPTION 'Register has an open shift' USING ERRCODE='ZX423'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION bind_shift_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pos pos_registers;
BEGIN
 PERFORM id FROM organizations WHERE id=NEW.organization_id FOR UPDATE;
 IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.store_id,NEW.register_id,NEW.register_key) IS DISTINCT FROM (OLD.organization_id,OLD.store_id,OLD.register_id,OLD.register_key) THEN RAISE EXCEPTION 'Shift register identity is immutable' USING ERRCODE='ZX403'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.register_id IS NULL THEN
   SELECT * INTO pos FROM pos_registers WHERE organization_id=NEW.organization_id AND store_id=NEW.store_id AND register_key=NEW.register_key;
   IF NOT FOUND THEN
    INSERT INTO pos_registers(organization_id,store_id,name,register_key,is_default,active)
     VALUES(NEW.organization_id,NEW.store_id,'POS '||left(NEW.register_key,100),NEW.register_key,
      NOT EXISTS(SELECT 1 FROM pos_registers WHERE organization_id=NEW.organization_id AND store_id=NEW.store_id AND is_default),NEW.status='open') RETURNING * INTO pos;
   END IF;
   NEW.register_id:=pos.id;
  END IF;
 END IF;
 IF NEW.status='open' THEN
  SELECT * INTO pos FROM pos_registers WHERE id=NEW.register_id AND organization_id=NEW.organization_id AND store_id=NEW.store_id;
  IF NOT FOUND OR NOT pos.active THEN RAISE EXCEPTION 'Active scoped POS register required' USING ERRCODE='ZX424'; END IF;
  IF NEW.register_key<>pos.register_key THEN RAISE EXCEPTION 'Register scope mismatch' USING ERRCODE='ZX403'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['users','stores','warehouses','products','customers','pos_registers'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS resource_capacity_guard ON %I',name);
  EXECUTE format('CREATE TRIGGER resource_capacity_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_resource_capacity()',name);
 END LOOP;
 DROP TRIGGER IF EXISTS subscription_business_write_guard ON pos_registers;
 CREATE TRIGGER subscription_business_write_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_registers FOR EACH ROW EXECUTE FUNCTION guard_subscription_business_write();
 DROP TRIGGER IF EXISTS pos_lifecycle_guard ON pos_registers;
 CREATE TRIGGER pos_lifecycle_guard BEFORE INSERT OR UPDATE ON pos_registers FOR EACH ROW EXECUTE FUNCTION guard_pos_register_lifecycle();
 DROP TRIGGER IF EXISTS pos_shift_register_guard ON shifts;
 CREATE TRIGGER pos_shift_register_guard BEFORE INSERT OR UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION bind_shift_register();
END $$;
