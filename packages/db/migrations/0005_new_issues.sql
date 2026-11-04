-- Set only when a ticket arrives after the project is connected, so a first import never counts as news.
ALTER TABLE issues ADD COLUMN announced_at timestamptz;
CREATE INDEX issues_project_announced ON issues (project_id, announced_at) WHERE announced_at IS NOT NULL;

CREATE TABLE project_reads (
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations (id),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, project_id)
);
