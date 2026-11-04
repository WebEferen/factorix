ALTER TABLE connections DROP CONSTRAINT connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check
  CHECK (kind IN ('linear', 'gitlab', 'anthropic', 'openai', 'mcp_stdio', 'mcp_http', 'generic', 'slack'));

-- How many workflow-created tickets led to this one, so tickets creating tickets has an end.
ALTER TABLE issues ADD COLUMN workflow_depth integer NOT NULL DEFAULT 0;

CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- The canvas autosaves here. Only the published copy ever runs, so a half-drawn change never fires.
  definition jsonb NOT NULL,
  published_definition jsonb,
  published_version integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  enabled boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_org ON workflows (org_id) WHERE archived_at IS NULL;

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version integer NOT NULL,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  -- A copy, so publishing a new version cannot change a run halfway through.
  definition jsonb NOT NULL,
  trigger jsonb NOT NULL,
  trigger_event_id text,
  started_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (workflow_id, issue_id, trigger_event_id)
);
-- What stops a workflow from re-triggering itself while it is still working on a ticket.
CREATE UNIQUE INDEX workflow_runs_one_active ON workflow_runs (workflow_id, issue_id) WHERE status = 'running';
CREATE INDEX workflow_runs_workflow ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX workflow_runs_issue ON workflow_runs (issue_id, created_at DESC);

CREATE TABLE workflow_steps (
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  block text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled')),
  handle text,
  output jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  wake_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_id)
);
CREATE INDEX workflow_steps_waiting ON workflow_steps (status, wake_at) WHERE status IN ('queued', 'running', 'waiting');
