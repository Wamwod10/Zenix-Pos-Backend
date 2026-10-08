-- migrate:no-transaction
-- Additive btree indexes for server-side pagination and platform dashboards.
-- Never rewrite existing product or business data.
CREATE INDEX CONCURRENTLY IF NOT EXISTS products_org_created_id_paging_idx
  ON products (organization_id,created_at DESC,id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS organizations_created_id_paging_idx
  ON organizations (created_at DESC,id DESC);
