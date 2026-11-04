ALTER TABLE organizations
  ADD COLUMN network_mode text NOT NULL DEFAULT 'extend' CHECK (network_mode IN ('extend', 'replace')),
  ADD COLUMN network_allowlist jsonb NOT NULL DEFAULT '[]';
