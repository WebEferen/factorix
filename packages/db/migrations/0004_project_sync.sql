ALTER TABLE projects
  ADD COLUMN sync_state text NOT NULL DEFAULT 'idle' CHECK (sync_state IN ('idle', 'syncing', 'failed')),
  ADD COLUMN sync_error text,
  ADD COLUMN synced_issue_count integer NOT NULL DEFAULT 0,
  ADD COLUMN sync_heartbeat_at timestamptz,
  ADD COLUMN last_synced_at timestamptz;

ALTER TABLE issues
  ADD COLUMN author_tracker_id text,
  ADD COLUMN author_name text;

CREATE INDEX issues_project_state ON issues (project_id, factory_state);

-- Imports used to stamp every row with the time of the import, which made recency meaningless.
UPDATE issues SET updated_at = tracker_updated_at WHERE factory_state = 'untracked' AND tracker_updated_at IS NOT NULL;

-- A null heartbeat reads as stale, so the worker re-imports these once on boot and fills in authors.
UPDATE projects SET sync_state = 'syncing';
