-- Only new-table indexes/constraints: existing large tables are not rewritten.
CREATE TABLE IF NOT EXISTS platform_promo_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id uuid NOT NULL CONSTRAINT platform_promo_reservations_promo_fk REFERENCES platform_promos(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL CONSTRAINT platform_promo_reservations_organization_fk REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL,
  plan text NOT NULL CHECK (plan IN ('MONTHLY','ANNUAL')),
  discount_amount numeric(18,2) NOT NULL CHECK (discount_amount>=0),
  quote_amount numeric(18,2) NOT NULL CHECK (quote_amount>=0),
  quote_service_period_from date,
  quote_service_period_to date,
  quote_extra_store_count integer NOT NULL DEFAULT 0 CHECK (quote_extra_store_count>=0),
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','CONSUMED','RELEASED')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  released_at timestamptz,
  release_reason text NOT NULL DEFAULT '' CHECK (length(release_reason)<=250),
  CONSTRAINT platform_promo_reservations_payment_unique UNIQUE(payment_id),
  CONSTRAINT platform_promo_reservations_payment_tenant_fk FOREIGN KEY(organization_id,payment_id)
    REFERENCES billing_payments(organization_id,id) ON DELETE CASCADE,
  CHECK ((status='RESERVED' AND consumed_at IS NULL AND released_at IS NULL AND release_reason='') OR
         (status='CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL AND release_reason='') OR
         (status='RELEASED' AND consumed_at IS NULL AND released_at IS NOT NULL AND length(release_reason)>0))
);
CREATE INDEX IF NOT EXISTS platform_promo_reservations_active_idx
  ON platform_promo_reservations(promo_id,organization_id) WHERE status='RESERVED';

-- Preserve pre-reservation pending immutable quotes, even after deactivation.
INSERT INTO platform_promo_reservations
  (promo_id,organization_id,payment_id,plan,discount_amount,quote_amount,quote_service_period_from,quote_service_period_to,quote_extra_store_count,reserved_at)
SELECT p.id,b.organization_id,b.id,b.plan,snapshot.discount,b.amount,b.service_period_from,b.service_period_to,
  COALESCE(b.extra_store_count,0),b.submitted_at
FROM billing_payments b
JOIN billing_drafts d ON d.id=b.draft_id AND d.organization_id=b.organization_id
JOIN platform_promos p ON p.id::text=d.metadata->>'promoId' AND p.code=d.metadata->>'promoCode'
CROSS JOIN LATERAL (SELECT CASE
  WHEN d.metadata->>'promoDiscount' ~ '^[0-9]{1,16}([.][0-9]{1,2})?$'
  THEN (d.metadata->>'promoDiscount')::numeric END AS discount) snapshot
WHERE b.status='REVIEW' AND b.type='LICENSE' AND d.type='LICENSE' AND b.plan=d.plan
  AND b.plan IN ('MONTHLY','ANNUAL') AND snapshot.discount>=0 AND snapshot.discount<d.base_amount
  AND snapshot.discount=round(d.base_amount*(CASE
    WHEN d.metadata->>'promoDiscountPercent' IN ('20','50','75','100')
    THEN (d.metadata->>'promoDiscountPercent')::integer END)/100)
  AND b.amount=d.total_amount
  AND COALESCE(b.extra_store_count,0)>=0
  AND d.base_amount+d.extra_store_amount-snapshot.discount=d.total_amount
ON CONFLICT(payment_id) DO NOTHING;

-- Payment is already locked by its UPDATE. Lock promo next, matching the
-- application's payment -> promo order, and cover every terminal writer.
CREATE OR REPLACE FUNCTION release_terminal_promo_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE reserved_promo uuid;
BEGIN
  IF NEW.status NOT IN ('REVIEW','APPROVED') THEN
    SELECT promo_id INTO reserved_promo FROM platform_promo_reservations
      WHERE payment_id=NEW.id AND organization_id=NEW.organization_id AND status='RESERVED';
    IF reserved_promo IS NOT NULL THEN
      PERFORM id FROM platform_promos WHERE id=reserved_promo FOR UPDATE;
      UPDATE platform_promo_reservations SET status='RELEASED',released_at=now(),
        release_reason=left(COALESCE(NULLIF(btrim(NEW.reject_reason),''),NEW.status),250)
        WHERE payment_id=NEW.id AND organization_id=NEW.organization_id AND status='RESERVED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='billing_payments'::regclass
    AND tgname='billing_payments_release_promo_reservation') THEN
    CREATE TRIGGER billing_payments_release_promo_reservation AFTER UPDATE OF status ON billing_payments
      FOR EACH ROW EXECUTE FUNCTION release_terminal_promo_reservation();
  END IF;
END $$;
