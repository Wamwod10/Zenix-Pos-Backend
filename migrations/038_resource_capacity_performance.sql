-- Review-required optimization. Do not apply automatically to production.
-- Atomic function replacement, no business rows or historical migrations changed.
-- Preserve the organization row lock, finite capacity counts and all validation.
-- Unlimited admission does not need usage; public two-argument usage still counts.
-- Rollback: restore the two function definitions from migration 034, then
-- DROP FUNCTION resource_entitlement(uuid,text,boolean). Lock timeout aborts safely.
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION resource_entitlement(org uuid,resource text,include_usage boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
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
 IF include_usage IS DISTINCT FROM false OR cap IS NOT NULL THEN
 CASE resource
  WHEN 'employees' THEN SELECT count(*) INTO used FROM users WHERE organization_id=org AND active AND app_role<>'OWNER';
  WHEN 'stores' THEN SELECT count(*) INTO used FROM stores WHERE organization_id=org AND (o.plan_code IS NOT NULL OR active);
  WHEN 'warehouses' THEN SELECT count(*) INTO used FROM warehouses WHERE organization_id=org;
  WHEN 'registers' THEN SELECT count(*) INTO used FROM pos_registers WHERE organization_id=org AND active;
  WHEN 'products' THEN SELECT count(*) INTO used FROM products WHERE organization_id=org;
  WHEN 'customers' THEN SELECT count(*) INTO used FROM customers WHERE organization_id=org;
 END CASE;
 ELSE used:=NULL; END IF;
 RETURN jsonb_build_object('resource',resource,'planCode',code,'pricingVersion',price_version,'limit',cap,'used',used,
  'remaining',CASE WHEN cap IS NULL THEN NULL ELSE greatest(0,cap-used) END,'overLimit',CASE WHEN cap IS NULL THEN 0 ELSE greatest(0,used-cap) END,
  'upgradeRequired',cap IS NOT NULL AND used>=cap AND code<>'PREMIUM','upgradeAvailable',code<>'PREMIUM');
END $$;
CREATE OR REPLACE FUNCTION resource_entitlement(org uuid,resource text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 RETURN resource_entitlement(org,resource,true);
END $$;
CREATE OR REPLACE FUNCTION assert_resource_capacity(org uuid,resource text,increase integer DEFAULT 1) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE state jsonb; cap bigint; used bigint; tier text;
BEGIN
 IF increase IS NULL OR increase<1 OR resource IS NULL OR resource NOT IN ('employees','stores','warehouses','registers','products','customers') THEN RAISE EXCEPTION 'Invalid increase' USING ERRCODE='ZX403'; END IF;
 SELECT plan_code INTO tier FROM organizations WHERE id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE='ZX403'; END IF;
 IF tier IS NULL THEN RETURN; END IF;
  state:=resource_entitlement(org,resource,false);cap:=(state->>'limit')::bigint;used:=(state->>'used')::bigint;
 IF cap IS NOT NULL AND used+increase>cap THEN
  RAISE EXCEPTION 'Resource limit reached' USING ERRCODE='ZX409',DETAIL=(state||jsonb_build_object('requestedIncrease',increase))::text;
 END IF;
END $$;
