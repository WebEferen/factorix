ALTER TABLE connections DROP CONSTRAINT connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check
  CHECK (kind IN ('linear', 'gitlab', 'github', 'anthropic', 'openai', 'mcp_stdio', 'mcp_http', 'generic', 'slack', 'doppler', 'factorix'));

-- Built-in tickets, for an organization with no tracker of its own. They sit behind the same connector contract as any
-- tracker, so issues still holds the mirror every other part of the factory reads. One connection per organization.
CREATE UNIQUE INDEX connections_factorix ON connections (org_id) WHERE kind = 'factorix';

CREATE TABLE ticket_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  next_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, key)
);

CREATE TABLE ticket_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES ticket_boards(id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_id uuid REFERENCES ticket_labels(id) ON DELETE CASCADE,
  is_group boolean NOT NULL DEFAULT false
);
CREATE INDEX ticket_labels_board ON ticket_labels (board_id);

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES ticket_boards(id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text NOT NULL,
  description text,
  priority integer NOT NULL DEFAULT 0,
  state_id text NOT NULL,
  label_ids jsonb NOT NULL DEFAULT '[]',
  creator_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, number)
);
CREATE INDEX tickets_updated ON tickets (board_id, updated_at, id);

CREATE TABLE ticket_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  body text NOT NULL,
  author_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_comments_ticket ON ticket_comments (ticket_id, created_at);
