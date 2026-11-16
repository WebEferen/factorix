-- When each "On a schedule" block of a published, enabled workflow fires next. The worker's sweep keeps it in step
-- with what is published, and claims a due row by moving next_at, so two workers cannot fire the same time twice.
CREATE TABLE workflow_schedules (
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_version integer NOT NULL,
  next_at timestamptz NOT NULL,
  PRIMARY KEY (workflow_id, node_id)
);

CREATE INDEX workflow_schedules_due ON workflow_schedules (next_at);
