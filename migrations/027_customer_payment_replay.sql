-- Existing payment rows without a client reference are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS customer_payment_client_reference_unique
ON customer_ledger (organization_id, (metadata->>'clientReference'))
WHERE entry_type='PAYMENT' AND COALESCE(metadata->>'clientReference','')<>'';
