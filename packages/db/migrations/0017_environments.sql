ALTER TABLE connections DROP CONSTRAINT connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check
  CHECK (kind IN ('linear', 'gitlab', 'anthropic', 'openai', 'mcp_stdio', 'mcp_http', 'generic', 'slack', 'doppler'));

-- How a project runs for previews and agent runs. The YAML is kept as typed, comments included, next to what it parsed to.
-- A null definition means secret sets are saved but no services are defined yet.
CREATE TABLE project_environments (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source text NOT NULL,
  definition jsonb,
  secret_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
