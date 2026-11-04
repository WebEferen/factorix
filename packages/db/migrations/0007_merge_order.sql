-- Merge order belongs to the ticket, because only the ticket says which change the others depend on.
ALTER TABLE issue_merge_requests ADD COLUMN merge_position integer;
