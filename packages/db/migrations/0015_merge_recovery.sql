ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('plan', 'tool', 'question', 'merge', 'partial_merge', 'revert_blocked'));

DROP INDEX approvals_one_pending_gate;
CREATE UNIQUE INDEX approvals_one_pending_gate ON approvals (issue_id, kind)
  WHERE status = 'pending' AND kind IN ('plan', 'merge', 'partial_merge', 'revert_blocked');

ALTER TABLE issue_merge_requests
  ADD COLUMN merge_error text,
  ADD COLUMN revert_mr_iid integer,
  ADD COLUMN revert_mr_url text,
  ADD COLUMN revert_state text CHECK (revert_state IN ('open', 'merged', 'failed')),
  ADD COLUMN revert_error text;

CREATE INDEX issue_merge_requests_revert_lookup ON issue_merge_requests (repo_id, revert_mr_iid) WHERE revert_mr_iid IS NOT NULL;

UPDATE pipelines
SET definition = jsonb_set(
  definition,
  '{steps}',
  (definition -> 'steps')
    || jsonb_build_object(
      'review', jsonb_set(definition #> '{steps,review}', '{on,mr.partial}', '"merge_partial"'),
      'address', jsonb_set(definition #> '{steps,address}', '{on,mr.partial}', '"merge_partial"'),
      'await_merge', jsonb_set(definition #> '{steps,await_merge}', '{on,mr.partial}', '"merge_partial"'),
      'merge_blocked', jsonb_set(definition #> '{steps,merge_blocked}', '{on,mr.partial}', '"merge_partial"'),
      'auto_merge', jsonb_set(jsonb_set(definition #> '{steps,auto_merge}', '{on,mr.partial}', '"merge_partial"'), '{on,partial}', '"merge_partial"')
    )
    || '{
      "merge_partial": {"kind": "gate", "approval": "partial_merge", "tracker": {"onEnter": "in_review"}, "on": {"retry": "auto_merge", "revert": "revert", "keep": "done", "mr.merged": "done"}},
      "revert": {"kind": "action", "action": "scm.revert", "on": {"blocked": "revert_blocked", "mr.reverted": "cancel"}},
      "revert_blocked": {"kind": "gate", "approval": "revert_blocked", "on": {"retry": "revert", "keep": "cancel", "mr.reverted": "cancel"}}
    }'::jsonb
)
WHERE is_builtin;
