-- A plugin is a server outside Factorix. An installation admin adds it, and each organization turns it on for itself.
CREATE TABLE plugins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL UNIQUE,
  manifest jsonb NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_plugins (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  config jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext bytea,
  secret_nonce bytea,
  key_version integer NOT NULL DEFAULT 1,
  enabled_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, plugin_id)
);

ALTER TABLE connections DROP CONSTRAINT connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check
  CHECK (kind IN ('linear', 'jira', 'trello', 'gitlab', 'github', 'anthropic', 'openai', 'mcp_stdio', 'mcp_http', 'generic', 'slack', 'doppler', 'factorix', 'plugin'));

ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_source_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_source_check CHECK (source IN ('linear', 'jira', 'trello', 'gitlab', 'github', 'plugin'));
