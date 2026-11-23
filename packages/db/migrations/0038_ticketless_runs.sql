-- A trigger from outside the tracker, like a Slack message or a plugin, starts a run with no ticket.
ALTER TABLE workflow_runs ALTER COLUMN issue_id DROP NOT NULL;
-- The table's own unique key treats every missing ticket as different, so a repeated event needs this to start once.
CREATE UNIQUE INDEX workflow_runs_ticketless_event ON workflow_runs (workflow_id, trigger_event_id) WHERE issue_id IS NULL;
