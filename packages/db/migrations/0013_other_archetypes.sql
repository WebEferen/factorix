ALTER TABLE archetypes DROP CONSTRAINT archetypes_role_check;
ALTER TABLE archetypes ADD CONSTRAINT archetypes_role_check CHECK (role IN ('engineer', 'reviewer', 'other'));

UPDATE pipelines
SET definition = jsonb_set(
  definition || '{"entryByRole": {"other": "task"}}'::jsonb,
  '{steps}',
  (definition -> 'steps') || '{
    "task": {"kind": "run", "role": "other", "phase": "task", "maxAttempts": 2, "onDone": {"completed": "task_done", "failed": "task_failed"}},
    "task_done": {"kind": "terminal", "state": "done"},
    "task_failed": {"kind": "terminal", "state": "failed"}
  }'::jsonb
)
WHERE is_builtin;
