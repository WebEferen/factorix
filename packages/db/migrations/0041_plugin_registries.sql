-- A registry an installation admin trusts, pinned to the key that signs its index. Organizations install what its last good
-- index lists, as far as `trust` allows.
CREATE TABLE plugin_registries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL UNIQUE,
  public_key text NOT NULL,
  trust text NOT NULL CHECK (trust IN ('signed', 'verified', 'reviewed')),
  catalog jsonb,
  issued_at timestamptz,
  fetched_at timestamptz,
  error text,
  added_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Where an installed package came from and who signed it. Null for one uploaded as a file.
ALTER TABLE plugin_instances ADD COLUMN source jsonb;
ALTER TABLE content_packs ADD COLUMN source jsonb;
