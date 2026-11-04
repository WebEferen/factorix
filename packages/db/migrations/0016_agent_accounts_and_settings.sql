ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_role_check;
ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_role_check CHECK (role IN ('mcp', 'model', 'tool', 'scm', 'tracker'));

-- One worker pool and one public address per deployment, so these belong to the instance and carry no org_id.
CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
