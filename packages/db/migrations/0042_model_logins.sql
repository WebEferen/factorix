-- A person's own model plan, used only for runs they started. A ChatGPT login keeps its tokens here, encrypted, and they
-- reach a run only through the egress proxy. A Claude login stays in the Claude Code CLI's own store, so its row holds
-- only what the CLI reports about it.
CREATE TABLE model_logins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('chatgpt', 'claude')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_login')),
  email text,
  subject text,
  plan text,
  client_id text,
  secret_ciphertext bytea,
  secret_nonce bytea,
  key_version integer NOT NULL DEFAULT 1,
  access_expires_at timestamptz,
  refreshed_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider)
);

ALTER TABLE organizations ADD COLUMN personal_model_logins boolean NOT NULL DEFAULT false;

-- Who set the issue's current pass going from inside Factorix. Its runs are theirs, so they may run on their plan.
ALTER TABLE issues ADD COLUMN started_by uuid REFERENCES accounts(id) ON DELETE SET NULL;

-- The person whose action in Factorix fired the trigger. Unlike started_by it does not exempt the run from the limits on
-- automatic runs.
ALTER TABLE workflow_runs ADD COLUMN caused_by uuid REFERENCES accounts(id) ON DELETE SET NULL;
UPDATE workflow_runs SET caused_by = started_by WHERE started_by IS NOT NULL;

ALTER TABLE runs ADD COLUMN model_plan text CHECK (model_plan IN ('chatgpt', 'claude'));
ALTER TABLE runs ADD COLUMN model_login_id uuid REFERENCES model_logins(id) ON DELETE SET NULL;
CREATE INDEX runs_live_model_login_idx ON runs (model_login_id) WHERE model_login_id IS NOT NULL;
