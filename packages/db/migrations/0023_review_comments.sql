-- 'summary' has the reviewer leave one note per merge request, with its findings listed in it, and no threads on the diff.
ALTER TABLE projects ADD COLUMN review_comments text NOT NULL DEFAULT 'inline' CHECK (review_comments IN ('inline', 'summary'));
