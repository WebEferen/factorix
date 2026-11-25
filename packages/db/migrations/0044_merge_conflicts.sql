-- Whether a merge request conflicts with its base branch, as the server last said. It stays as it was while the server works it out.
ALTER TABLE issue_merge_requests ADD COLUMN has_conflicts boolean NOT NULL DEFAULT false;

-- Nothing is handed over for merging while it conflicts: an engineer run merges the base branch in, and review sees the result.
UPDATE pipelines
SET definition = jsonb_set(
  definition,
  '{steps}',
  (definition -> 'steps')
    || jsonb_build_object(
      'review', jsonb_set(
        jsonb_set(
          jsonb_set(definition #> '{steps,review}', '{onLoopsExceeded}', '"check_conflicts"'),
          '{onDone,verdict:approve}', '"check_conflicts"'
        ),
        '{onDone,failed}', '"check_conflicts"'
      ),
      'address', jsonb_set(definition #> '{steps,address}', '{onDone,no_changes}', '"check_conflicts"'),
      'await_merge', jsonb_set(definition #> '{steps,await_merge}', '{on,resolve}', '"resolve_conflicts"'),
      'merge_blocked', jsonb_set(definition #> '{steps,merge_blocked}', '{on,resolve}', '"resolve_conflicts"'),
      'auto_merge', jsonb_set(definition #> '{steps,auto_merge}', '{on,conflicts}', '"resolve_conflicts"')
    )
    || '{
      "check_conflicts": {"kind": "action", "action": "scm.conflicts", "on": {"clean": "await_merge", "conflicts": "resolve_conflicts", "mr.merged": "done", "mr.closed": "cancel", "mr.partial": "merge_partial"}},
      "resolve_conflicts": {"kind": "run", "role": "engineer", "phase": "resolve_conflicts", "maxLoops": 3, "onLoopsExceeded": "merge_blocked", "maxAttempts": 2, "tracker": {"onEnter": "in_progress"}, "on": {"mr.merged": "done", "mr.closed": "cancel", "mr.partial": "merge_partial"}, "onDone": {"completed": "review", "no_changes": "check_conflicts", "failed": "merge_blocked"}}
    }'::jsonb
)
WHERE is_builtin;
