-- The tickets a plugin created, for tickets:write. A plugin reads back only these, so this table is the limit of what
-- it sees of an organization's tickets through that permission.
CREATE TABLE plugin_tickets (
  plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, issue_id)
);
