CREATE UNIQUE INDEX IF NOT EXISTS inventory_receipt_client_reference_unique
ON audit_logs (organization_id, (metadata->>'clientReference'))
WHERE action='receive' AND entity_type='inventory' AND COALESCE(metadata->>'clientReference','')<>'';
