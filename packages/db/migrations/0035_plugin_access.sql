-- What an organization's admin allowed a plugin to ask of Factorix, copied from its manifest when they turned it on or
-- saved its settings. A permission a newer manifest adds stays refused until they save again.
ALTER TABLE organization_plugins ADD COLUMN permissions text[] NOT NULL DEFAULT '{}';

-- A bundled plugin ships in the repository's plugins/ folder and registers itself. Factorix calls it on the internal
-- network, while people open its pages at page_url, an origin of its own.
ALTER TABLE plugins ADD COLUMN page_url text;
ALTER TABLE plugins ADD COLUMN bundled boolean NOT NULL DEFAULT false;
