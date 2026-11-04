CREATE TABLE pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  definition jsonb NOT NULL,
  is_builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name, version)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  tracker_connection_id uuid NOT NULL REFERENCES connections(id),
  tracker_team_id text NOT NULL,
  tracker_project_id text,
  scm_connection_id uuid NOT NULL REFERENCES connections(id),
  scm_repo_id text NOT NULL,
  scm_repo_path text NOT NULL,
  scm_clone_url text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  autonomy text NOT NULL DEFAULT 'human_merge' CHECK (autonomy IN ('plan_first', 'human_merge', 'full_auto')),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id),
  state_map jsonb NOT NULL DEFAULT '{}',
  trigger jsonb NOT NULL DEFAULT '{"states": ["Todo"]}',
  agent_label_group_id text,
  agent_labels jsonb NOT NULL DEFAULT '{}',
  sandbox_image text,
  setup_command text,
  test_command text,
  network_policy text NOT NULL DEFAULT 'restricted' CHECK (network_policy IN ('restricted', 'open', 'none')),
  network_allowlist jsonb NOT NULL DEFAULT '[]',
  limits jsonb NOT NULL DEFAULT '{}',
  run_timeout_minutes integer NOT NULL DEFAULT 90,
  monthly_budget_usd numeric(10, 2),
  default_engineer_agent_id uuid REFERENCES agents(account_id) ON DELETE SET NULL,
  default_reviewer_agent_id uuid REFERENCES agents(account_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE UNIQUE INDEX projects_tracker_scope ON projects (tracker_connection_id, tracker_team_id, COALESCE(tracker_project_id, ''));

CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tracker_issue_id text NOT NULL,
  identifier text NOT NULL,
  title text NOT NULL,
  description text,
  priority integer NOT NULL DEFAULT 0,
  tracker_state_id text,
  tracker_state_name text,
  tracker_state_type text,
  labels jsonb NOT NULL DEFAULT '[]',
  assignee_tracker_id text,
  assignee_name text,
  tracker_updated_at timestamptz,
  tracker_url text,
  last_factory_state_id text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  factory_state text NOT NULL DEFAULT 'untracked' CHECK (factory_state IN ('untracked', 'queued', 'active', 'waiting_human', 'awaiting_merge', 'done', 'failed', 'cancelled')),
  assigned_agent_id uuid REFERENCES agents(account_id) ON DELETE SET NULL,
  cursor jsonb,
  branch_name text,
  mr_id text,
  mr_iid integer,
  mr_url text,
  mr_state text,
  locked_by_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, tracker_issue_id)
);
CREATE INDEX issues_org_project ON issues (org_id, project_id, updated_at DESC);
CREATE INDEX issues_factory_state ON issues (org_id, factory_state);
CREATE INDEX issues_open_mr ON issues (project_id) WHERE mr_iid IS NOT NULL AND factory_state NOT IN ('done', 'cancelled');

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id uuid UNIQUE REFERENCES issues(id) ON DELETE CASCADE,
  volume_name text NOT NULL,
  mirror_volume_name text NOT NULL,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'in_use', 'expired')),
  head_sha text,
  branch text,
  repo_docs jsonb NOT NULL DEFAULT '[]',
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL REFERENCES agents(account_id),
  agent_snapshot jsonb NOT NULL,
  phase text NOT NULL,
  pipeline_step text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'preparing', 'running', 'waiting_approval', 'suspended', 'finalizing', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 1,
  parent_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  trigger jsonb NOT NULL DEFAULT '{}',
  ad_hoc jsonb,
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  runtime text NOT NULL,
  model text,
  session_ref text,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  container_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  outcome text,
  result text,
  summary text,
  structured_output jsonb,
  usage jsonb NOT NULL DEFAULT '{}',
  cost_usd numeric(12, 4),
  cost_estimated boolean NOT NULL DEFAULT false,
  diff text,
  error jsonb,
  last_seq integer NOT NULL DEFAULT 0,
  last_runner_seq integer NOT NULL DEFAULT 0,
  cancel_requested_at timestamptz,
  discard_on_cancel boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_org_created ON runs (org_id, created_at DESC);
CREATE INDEX runs_issue ON runs (issue_id, created_at DESC);
CREATE INDEX runs_recover ON runs (lease_expires_at) WHERE state IN ('preparing', 'running', 'waiting_approval', 'finalizing');
CREATE INDEX runs_project_month ON runs (project_id, created_at);

ALTER TABLE issues ADD CONSTRAINT issues_locked_by_run FOREIGN KEY (locked_by_run_id) REFERENCES runs(id) ON DELETE SET NULL;

CREATE TABLE run_events (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE TRIGGER run_events_append_only BEFORE UPDATE ON run_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE run_commands (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX run_commands_pending ON run_commands (run_id) WHERE delivered_at IS NULL;

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  issue_id uuid REFERENCES issues(id) ON DELETE CASCADE,
  runner_approval_id text,
  kind text NOT NULL CHECK (kind IN ('plan', 'tool', 'question', 'merge')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  payload jsonb NOT NULL DEFAULT '{}',
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  decided_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision jsonb,
  external_ref jsonb
);
CREATE INDEX approvals_org_status ON approvals (org_id, status, requested_at DESC);
CREATE INDEX approvals_issue ON approvals (issue_id, status);
CREATE UNIQUE INDEX approvals_one_pending_gate ON approvals (issue_id, kind) WHERE status = 'pending' AND kind IN ('plan', 'merge');
