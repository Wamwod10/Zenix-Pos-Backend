-- Nullable purpose preserves existing records; read policy infers legacy references.
ALTER TABLE file_assets ADD COLUMN purpose text CHECK(purpose IN ('product','expense'));
