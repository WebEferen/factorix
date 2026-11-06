-- A running copy of a project's environment. A preview keeps one row per issue across stops and starts, so its address,
-- installed dependencies, and data survive. The definition and secret sets are a snapshot of the version it started with.
CREATE TABLE environment_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id uuid REFERENCES issues(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('preview', 'run')),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]{10}$'),
  state text NOT NULL CHECK (state IN ('starting', 'ready', 'refreshing', 'stopping', 'stopped', 'failed')),
  definition jsonb,
  definition_version integer,
  secret_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  commits jsonb NOT NULL DEFAULT '{}'::jsonb,
  services jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_generation integer NOT NULL DEFAULT 1,
  error text,
  started_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  started_at timestamptz,
  ready_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX environment_instances_one_preview ON environment_instances (issue_id) WHERE kind = 'preview';
CREATE INDEX environment_instances_live ON environment_instances (org_id, state) WHERE state <> 'stopped';
