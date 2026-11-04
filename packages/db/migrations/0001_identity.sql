CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  handle text NOT NULL,
  display_name text NOT NULL,
  email text,
  password_hash text,
  avatar_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, handle),
  CHECK (kind = 'agent' OR email IS NOT NULL)
);
CREATE UNIQUE INDEX accounts_email_unique ON accounts (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_account ON auth_sessions (account_id);

CREATE TABLE agents (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  persona text NOT NULL,
  description text NOT NULL DEFAULT '',
  system_prompt text NOT NULL DEFAULT '',
  runtime text NOT NULL,
  model text,
  reasoning_effort text,
  max_budget_usd numeric(10, 2),
  max_turns integer,
  policy jsonb NOT NULL,
  capabilities_snapshot jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_org_persona ON agents (org_id, persona);

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  markdown text NOT NULL,
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE agent_skills (
  agent_id uuid NOT NULL REFERENCES agents(account_id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('linear', 'gitlab', 'anthropic', 'openai', 'mcp_stdio', 'mcp_http', 'generic')),
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext bytea,
  secret_nonce bytea,
  key_version integer NOT NULL DEFAULT 1,
  agent_visible boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE agent_connections (
  agent_id uuid NOT NULL REFERENCES agents(account_id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('mcp', 'model', 'tool')),
  PRIMARY KEY (agent_id, connection_id)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_ts ON audit_log (org_id, ts DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_account_id, ts DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only BEFORE DELETE ON audit_log
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_content_update BEFORE UPDATE OF org_id, actor_kind, action, target_type, target_id, metadata, ts ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
