-- Returns belong to the business day on which the refund is actually processed,
-- not necessarily the day of the original sale. This keeps closed daily reports
-- immutable and makes current-day cash/card/transfer totals auditable.
ALTER TABLE sale_returns ADD COLUMN IF NOT EXISTS business_date date;

UPDATE sale_returns r
SET business_date=s.business_date
FROM sales s
WHERE r.sale_id=s.id AND r.business_date IS NULL;

ALTER TABLE sale_returns ALTER COLUMN business_date SET NOT NULL;
CREATE INDEX IF NOT EXISTS sale_returns_business_day_idx
  ON sale_returns(organization_id,store_id,business_date,created_at);
