CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'Asia/Tashkent',
  currency text NOT NULL DEFAULT 'UZS',
  plan text NOT NULL DEFAULT 'ANNUAL',
  license_status text NOT NULL DEFAULT 'PAYMENT_REQUIRED',
  expiry_date date,
  store_limit integer NOT NULL DEFAULT 2 CHECK (store_limit > 0),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  name text NOT NULL,
  username text NOT NULL,
  phone text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  app_role text NOT NULL,
  permission_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_org_username_unique UNIQUE (organization_id, username)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_org_phone_unique ON users (organization_id, regexp_replace(phone, '\\D','','g')) WHERE active=true AND phone<>'';
CREATE UNIQUE INDEX IF NOT EXISTS users_username_global_unique ON users (lower(username));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text NOT NULL DEFAULT '',
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ui_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  sku text NOT NULL DEFAULT '',
  barcode text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  brand text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'dona',
  cost_price numeric(18,2) NOT NULL DEFAULT 0 CHECK (cost_price>=0),
  sell_price numeric(18,2) NOT NULL DEFAULT 0 CHECK (sell_price>=0),
  wholesale_price numeric(18,2) NOT NULL DEFAULT 0 CHECK (wholesale_price>=0),
  min_stock numeric(18,3) NOT NULL DEFAULT 0 CHECK (min_stock>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS products_org_sku_unique ON products(organization_id, lower(sku)) WHERE sku<>'';
CREATE UNIQUE INDEX IF NOT EXISTS products_org_barcode_unique ON products(organization_id, barcode) WHERE barcode<>'';
CREATE INDEX IF NOT EXISTS products_org_active_idx ON products(organization_id, archived, name);

CREATE TABLE IF NOT EXISTS inventory_balances (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity numeric(18,3) NOT NULL DEFAULT 0,
  avg_cost numeric(18,2) NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE IF NOT EXISTS inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  reference_id text NOT NULL DEFAULT '',
  batch_no text NOT NULL DEFAULT '',
  expiry_date date,
  received_quantity numeric(18,3) NOT NULL CHECK (received_quantity>0),
  remaining_quantity numeric(18,3) NOT NULL CHECK (remaining_quantity>=0),
  unit_cost numeric(18,2) NOT NULL DEFAULT 0 CHECK (unit_cost>=0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_batches_lookup_idx ON inventory_batches(organization_id,store_id,product_id,expiry_date);

CREATE TABLE IF NOT EXISTS product_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  serial text NOT NULL,
  status text NOT NULL DEFAULT 'IN_STOCK',
  reference_id text NOT NULL DEFAULT '',
  sale_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, serial)
);
CREATE INDEX IF NOT EXISTS product_serials_lookup_idx ON product_serials(organization_id,product_id,store_id,status);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  type text NOT NULL,
  quantity numeric(18,3) NOT NULL,
  before_quantity numeric(18,3) NOT NULL,
  after_quantity numeric(18,3) NOT NULL,
  unit_cost numeric(18,2) NOT NULL DEFAULT 0,
  reference_type text NOT NULL DEFAULT '',
  reference_id text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_lookup_idx ON stock_movements(organization_id, store_id, product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  cashier_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  register_key text NOT NULL DEFAULT 'default',
  status text NOT NULL DEFAULT 'open',
  opening_cash numeric(18,2) NOT NULL DEFAULT 0,
  expected_cash numeric(18,2),
  actual_cash numeric(18,2),
  difference numeric(18,2),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_open_register_unique ON shifts(organization_id,store_id,register_key) WHERE status='open';

CREATE TABLE IF NOT EXISTS shift_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('in','out')),
  amount numeric(18,2) NOT NULL CHECK (amount>0),
  reason text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual',
  reference_id text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  seller_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sale_number text NOT NULL,
  client_reference text NOT NULL DEFAULT '',
  subtotal numeric(18,2) NOT NULL DEFAULT 0,
  discount_amount numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  returned_amount numeric(18,2) NOT NULL DEFAULT 0,
  customer jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_date date NOT NULL DEFAULT CURRENT_DATE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_org_number_unique UNIQUE (organization_id, sale_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_org_client_reference_unique ON sales(organization_id,client_reference) WHERE client_reference<>'';
CREATE INDEX IF NOT EXISTS sales_org_store_date_idx ON sales(organization_id,store_id,created_at DESC);

CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name text NOT NULL,
  sku text NOT NULL DEFAULT '',
  barcode text NOT NULL DEFAULT '',
  quantity numeric(18,3) NOT NULL CHECK (quantity>0),
  unit_price numeric(18,2) NOT NULL CHECK (unit_price>=0),
  discount_percent numeric(8,3) NOT NULL DEFAULT 0,
  line_total numeric(18,2) NOT NULL CHECK (line_total>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS sale_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method text NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS sale_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK (quantity>0),
  amount numeric(18,2) NOT NULL CHECK (amount>=0),
  reason text NOT NULL DEFAULT '',
  refund_method text NOT NULL DEFAULT 'original',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  contact_name text NOT NULL DEFAULT '',
  telegram text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_org_phone_unique ON suppliers(organization_id, regexp_replace(phone,'\\D','','g')) WHERE archived=false AND phone<>'';

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  invoice_no text NOT NULL DEFAULT '',
  total numeric(18,2) NOT NULL DEFAULT 0,
  paid_amount numeric(18,2) NOT NULL DEFAULT 0,
  due_date date,
  note text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES supplier_invoices(id) ON DELETE SET NULL,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  amount numeric(18,2) NOT NULL CHECK (amount>0),
  method text NOT NULL,
  note text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL DEFAULT '',
  quantity numeric(18,3) NOT NULL CHECK (quantity>0),
  unit_cost numeric(18,2) NOT NULL DEFAULT 0 CHECK (unit_cost>=0),
  total numeric(18,2) NOT NULL DEFAULT 0 CHECK (total>=0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  title text NOT NULL,
  category text NOT NULL DEFAULT '',
  amount numeric(18,2) NOT NULL CHECK (amount>0),
  payment_method text NOT NULL DEFAULT 'cash',
  note text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  to_store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',
  difference_reason text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  received_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_store_id<>to_store_id)
);
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sent_quantity numeric(18,3) NOT NULL CHECK (sent_quantity>0),
  received_quantity numeric(18,3),
  UNIQUE (transfer_id, product_id)
);

CREATE TABLE IF NOT EXISTS inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft',
  snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL
);


CREATE TABLE IF NOT EXISTS sale_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  name text NOT NULL DEFAULT '',
  cart jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  cart_discount_percent numeric(8,3) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sale_holds_lookup_idx ON sale_holds(organization_id,store_id,user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS business_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'closed',
  total numeric(18,2) NOT NULL DEFAULT 0,
  cash numeric(18,2) NOT NULL DEFAULT 0,
  card numeric(18,2) NOT NULL DEFAULT 0,
  transfer numeric(18,2) NOT NULL DEFAULT 0,
  sale_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,store_id,business_date)
);

CREATE TABLE IF NOT EXISTS billing_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type text NOT NULL,
  plan text NOT NULL DEFAULT '',
  current_end_date date,
  selected_end_date date,
  extension_days integer NOT NULL DEFAULT 0,
  base_amount numeric(18,2) NOT NULL DEFAULT 0,
  extra_store_count integer NOT NULL DEFAULT 0,
  extra_store_amount numeric(18,2) NOT NULL DEFAULT 0,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '2 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_draft_open_unique ON billing_drafts(organization_id, created_by) WHERE status='open';
CREATE UNIQUE INDEX IF NOT EXISTS billing_draft_order_unique ON billing_drafts(order_id);

CREATE TABLE IF NOT EXISTS billing_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  file_size integer NOT NULL CHECK (file_size>0 AND file_size<=5242880),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_receipts_org_idx ON billing_receipts(organization_id,created_at DESC);

CREATE TABLE IF NOT EXISTS billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  draft_id uuid REFERENCES billing_drafts(id) ON DELETE SET NULL,
  order_id text NOT NULL,
  type text NOT NULL,
  plan text NOT NULL DEFAULT '',
  amount numeric(18,2) NOT NULL,
  status text NOT NULL DEFAULT 'REVIEW',
  service_period_from date,
  service_period_to date,
  extension_days integer NOT NULL DEFAULT 0,
  extra_store_count integer NOT NULL DEFAULT 0,
  receipt_id uuid REFERENCES billing_receipts(id) ON DELETE SET NULL,
  receipt_name text NOT NULL DEFAULT '',
  receipt_type text NOT NULL DEFAULT '',
  reject_reason text NOT NULL DEFAULT '',
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE (organization_id, order_id)
);

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telegram_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  chat_title text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id)
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text NOT NULL DEFAULT '',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type,event_id)
);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS file_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  file_size integer NOT NULL CHECK (file_size >= 0 AND file_size <= 8388608),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS file_assets_org_idx ON file_assets(organization_id,created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_org_date_idx ON audit_logs(organization_id,created_at DESC);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='organizations_touch_updated_at') THEN CREATE TRIGGER organizations_touch_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION touch_updated_at(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='stores_touch_updated_at') THEN CREATE TRIGGER stores_touch_updated_at BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION touch_updated_at(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='users_touch_updated_at') THEN CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='products_touch_updated_at') THEN CREATE TRIGGER products_touch_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_updated_at(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='suppliers_touch_updated_at') THEN CREATE TRIGGER suppliers_touch_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION touch_updated_at(); END IF;
END $$;
