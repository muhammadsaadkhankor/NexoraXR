-- Operator-editable application settings (branding, etc.).
-- Keys: app_name, logo_asset, favicon_asset (asset values = filenames under
-- server uploads/, served via /api/branding/asset/:name).

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
