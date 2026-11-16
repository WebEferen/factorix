-- A person signs in once and can be a member of several organizations. Each membership stays an account, so everything
-- that names an account keeps naming one person in one organization.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text,
  display_name text NOT NULL,
  -- May create organizations and change what belongs to the whole installation.
  installation_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Where the next sign-in lands.
  last_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

ALTER TABLE accounts ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- Until now an admin of the one organization could change installation settings, so they keep that.
INSERT INTO users (email, password_hash, display_name, installation_admin, status, created_at)
SELECT email, password_hash, display_name, role = 'admin', status, created_at
FROM accounts
WHERE kind = 'human' AND email IS NOT NULL;

UPDATE accounts SET user_id = users.id FROM users WHERE accounts.kind = 'human' AND lower(accounts.email) = lower(users.email);

ALTER TABLE users ADD CONSTRAINT users_last_account_fk FOREIGN KEY (last_account_id) REFERENCES accounts(id) ON DELETE SET NULL;

DROP INDEX accounts_email_unique;
CREATE UNIQUE INDEX accounts_org_user_unique ON accounts (org_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX accounts_user ON accounts (user_id) WHERE user_id IS NOT NULL;
ALTER TABLE accounts ADD CONSTRAINT accounts_human_has_user CHECK (kind = 'agent' OR user_id IS NOT NULL);
ALTER TABLE accounts DROP COLUMN password_hash;
