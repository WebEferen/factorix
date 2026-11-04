CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('linear', 'gitlab')),
  delivery_id text NOT NULL,
  event_type text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'ignored', 'failed')),
  error text,
  UNIQUE (source, delivery_id)
);
CREATE INDEX webhook_deliveries_status ON webhook_deliveries (status, received_at);

CREATE TABLE echo_markers (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX echo_markers_lookup ON echo_markers (source, entity_type, entity_id, fingerprint, created_at DESC);
CREATE INDEX echo_markers_created ON echo_markers (created_at);

CREATE TABLE mr_discussions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  mr_iid integer NOT NULL,
  discussion_id text NOT NULL,
  note_id text NOT NULL,
  author_login text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('factory', 'human', 'system')),
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  body text NOT NULL,
  path text,
  line integer,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, note_id)
);
CREATE INDEX mr_discussions_open ON mr_discussions (issue_id, resolved);

CREATE TABLE issue_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  source text NOT NULL,
  external_id text,
  author text,
  body text NOT NULL,
  consumed_by_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, source, external_id)
);
CREATE INDEX issue_instructions_pending ON issue_instructions (issue_id) WHERE consumed_by_run_id IS NULL;

CREATE TABLE domain_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX domain_events_pending ON domain_events (id) WHERE processed_at IS NULL;
