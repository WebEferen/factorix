-- created_at is when the row was mirrored, so every imported issue would look as new as its import.
ALTER TABLE issues ADD COLUMN tracker_created_at timestamptz;

-- A null heartbeat reads as stale, so the worker re-imports these once and fills in the dates.
UPDATE projects SET sync_state = 'syncing', sync_heartbeat_at = NULL;
