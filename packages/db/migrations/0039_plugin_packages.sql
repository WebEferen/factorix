-- A plugin an organization's admin uploads as a package. Factorix runs it for that organization alone, in an environment of
-- its own on this machine or one of the organization's runners, and keeps the package to start it again.
ALTER TABLE plugins ADD COLUMN org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX plugins_package_name ON plugins (org_id, name) WHERE org_id IS NOT NULL;

-- The slug names its network and volumes, fx-env-<slug>, the same namespace previews use.
CREATE TABLE plugin_instances (
  plugin_id uuid PRIMARY KEY REFERENCES plugins(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]{10}$'),
  runner_id uuid REFERENCES runners(id) ON DELETE SET NULL,
  package jsonb NOT NULL,
  archive bytea NOT NULL,
  sha256 text NOT NULL,
  state text NOT NULL CHECK (state IN ('starting', 'ready', 'failed', 'removing')),
  error text,
  container_id text,
  uploaded_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
