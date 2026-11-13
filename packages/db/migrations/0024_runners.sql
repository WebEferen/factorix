-- A machine elsewhere that runs a project's sandboxes. It connects out to Factorix with a token, of which only the hash is stored.
CREATE TABLE runners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  last_seen_at timestamptz,
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE projects ADD COLUMN runner_id uuid REFERENCES runners(id) ON DELETE SET NULL;

-- Where each workspace was first made, with NULL for this machine. Its volumes are there, so later runs on the same issue go there
-- even after the project moves to another runner.
CREATE TABLE workspace_runners (
  workspace_key text PRIMARY KEY,
  runner_id uuid REFERENCES runners(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
