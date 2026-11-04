CREATE TABLE archetypes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  role text NOT NULL CHECK (role IN ('engineer', 'reviewer')),
  system_prompt text NOT NULL DEFAULT '',
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX archetypes_org_name ON archetypes (org_id, lower(name));

INSERT INTO archetypes (org_id, name, description, role, system_prompt)
SELECT organizations.id, preset.name, preset.description, preset.role, preset.system_prompt
FROM organizations CROSS JOIN (VALUES
  (
    'Engineer',
    'Takes a ticket, implements it on a branch, and opens a merge request.',
    'engineer',
    E'You are a senior software engineer. Read the code before changing it, keep the diff as small as the problem allows, and match the surrounding style.\nProve the change works by running the relevant checks. If you cannot finish, say exactly what is missing instead of guessing.'
  ),
  (
    'Reviewer',
    'Reviews merge requests and posts findings as discussion threads.',
    'reviewer',
    E'You are a principal engineer reviewing a teammate''s merge request. Look for correctness, security, concurrency, and data problems first.\nBe specific: name the failing scenario, not a general concern. Do not comment on style the linter already covers.'
  ),
  (
    'Tester',
    'Writes and runs the tests a ticket needs, then opens a merge request with them.',
    'engineer',
    E'You are a test engineer. Reproduce the problem or exercise the requested behavior first, then add the tests that would have caught it. Prefer tests of real behavior over tests of internals, and change production code only when a test proves it wrong.\nSay what you covered and what you could not.'
  ),
  (
    'Incident manager',
    'Finds what broke, ships the smallest safe fix, and writes up what happened.',
    'engineer',
    E'You are handling a production incident. Establish what is broken, who is affected, and since when before changing anything. Prefer the smallest safe fix or a revert over a refactor.\nEnd with the timeline, the cause, and the follow-ups.'
  )
) AS preset (name, description, role, system_prompt);

-- The API accepted any text as a persona, so an agent may hold one that is not a preset.
INSERT INTO archetypes (org_id, name, role)
SELECT DISTINCT agents.org_id, initcap(replace(replace(agents.persona, '-', ' '), '_', ' ')), 'engineer'
FROM agents
WHERE NOT EXISTS (
  SELECT 1 FROM archetypes
  WHERE archetypes.org_id = agents.org_id AND lower(archetypes.name) = lower(replace(replace(agents.persona, '-', ' '), '_', ' '))
);

ALTER TABLE agents ADD COLUMN archetype_id uuid REFERENCES archetypes(id) ON DELETE RESTRICT;

UPDATE agents SET archetype_id = archetypes.id
FROM archetypes
WHERE archetypes.org_id = agents.org_id AND lower(archetypes.name) = lower(replace(replace(agents.persona, '-', ' '), '_', ' '));

-- Agents now inherit the archetype's prompt. Keeping an identical copy would send it twice.
UPDATE agents SET system_prompt = ''
FROM archetypes
WHERE archetypes.id = agents.archetype_id AND trim(agents.system_prompt) = trim(archetypes.system_prompt);

ALTER TABLE agents ALTER COLUMN archetype_id SET NOT NULL;
DROP INDEX agents_org_persona;
ALTER TABLE agents DROP COLUMN persona;
CREATE INDEX agents_archetype ON agents (archetype_id);

UPDATE pipelines SET definition = replace(definition::text, '"persona":', '"role":')::jsonb;
