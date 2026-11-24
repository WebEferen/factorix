-- How a project retries a run that broke down: a crash, a lost worker, a model limit, or the time limit. Each retry waits
-- retry_delay_seconds, doubled for every attempt after the second.
ALTER TABLE projects
  ADD COLUMN retry_attempts integer NOT NULL DEFAULT 2 CHECK (retry_attempts BETWEEN 1 AND 5),
  ADD COLUMN retry_delay_seconds integer NOT NULL DEFAULT 30 CHECK (retry_delay_seconds BETWEEN 0 AND 3600);

-- lost_count counts the workers that died holding the run. not_before keeps a retry from starting before its delay is up.
ALTER TABLE runs
  ADD COLUMN lost_count integer NOT NULL DEFAULT 0,
  ADD COLUMN not_before timestamptz;
