-- What a token may change. Reading needs none. Tokens made before this keep what the CLI used, which never included previews.
ALTER TABLE api_tokens ADD COLUMN scopes text[] NOT NULL DEFAULT '{runs,issues,approvals}';
