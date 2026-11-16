ALTER TABLE connections DROP CONSTRAINT connections_kind_check;
ALTER TABLE connections ADD CONSTRAINT connections_kind_check
  CHECK (kind IN ('linear', 'jira', 'gitlab', 'github', 'anthropic', 'openai', 'mcp_stdio', 'mcp_http', 'generic', 'slack', 'doppler', 'factorix'));

ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_source_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_source_check CHECK (source IN ('linear', 'jira', 'gitlab', 'github'));
