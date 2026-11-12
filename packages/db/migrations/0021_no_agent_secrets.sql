-- Agent runs never get secret values, so secret sets lose the flag that used to let them.
UPDATE project_environments
SET secret_sets = (
  SELECT coalesce(jsonb_agg(item - 'agents' ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(secret_sets) WITH ORDINALITY AS sets(item, ord)
)
WHERE jsonb_path_exists(secret_sets, '$[*].agents');

UPDATE environment_instances
SET secret_sets = (
  SELECT coalesce(jsonb_agg(item - 'agents' ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(secret_sets) WITH ORDINALITY AS sets(item, ord)
)
WHERE jsonb_path_exists(secret_sets, '$[*].agents');

-- Generic connections lose the flag that put their values in an agent's environment.
ALTER TABLE connections DROP COLUMN agent_visible;
