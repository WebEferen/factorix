-- A package of content: skills, archetypes, and workflows an organization's admin imports. What it made stays the
-- organization's own, and each item remembers what it held when the package wrote it, so an upgrade or removal only
-- touches what nobody changed since.
CREATE TABLE content_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  version text NOT NULL,
  manifest jsonb NOT NULL,
  sha256 text NOT NULL,
  installed_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE content_pack_items (
  pack_id uuid NOT NULL REFERENCES content_packs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('skill', 'archetype', 'workflow')),
  key text NOT NULL,
  target_id uuid NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY (pack_id, kind, key)
);
CREATE INDEX content_pack_items_target ON content_pack_items (kind, target_id);
