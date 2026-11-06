-- A preview runs pushed code, or an agent's working copy that it asked for mid-run.
ALTER TABLE environment_instances ADD COLUMN source text NOT NULL DEFAULT 'branch' CHECK (source IN ('branch', 'worktree'));
