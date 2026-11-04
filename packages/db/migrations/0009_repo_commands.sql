-- One command per repository left no room for lint, typecheck, and tests side by side.
ALTER TABLE project_repos
  ADD COLUMN setup_commands jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN check_commands jsonb NOT NULL DEFAULT '[]';

UPDATE project_repos SET
  setup_commands = CASE WHEN COALESCE(setup_command, '') = '' THEN '[]'::jsonb ELSE jsonb_build_array(setup_command) END,
  check_commands = CASE WHEN COALESCE(test_command, '') = '' THEN '[]'::jsonb ELSE jsonb_build_array(test_command) END;

ALTER TABLE project_repos DROP COLUMN setup_command, DROP COLUMN test_command;
