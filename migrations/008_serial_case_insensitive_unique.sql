-- Serial/IMEI identifiers are case-insensitive in Zenix POS. Keep the existing
-- exact unique constraint and add a normalized index so concurrent requests
-- cannot insert case variants of the same serial.
CREATE UNIQUE INDEX IF NOT EXISTS product_serials_org_serial_ci_unique
  ON product_serials(organization_id, lower(serial));
