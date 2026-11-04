-- A project can span several repositories. Each one that an issue changes gets its own merge request.
CREATE TABLE project_repos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scm_repo_id text NOT NULL,
  scm_repo_path text NOT NULL,
  scm_clone_url text NOT NULL,
  default_branch text NOT NULL,
  -- The folder under /workspace/repos, used in shell steps, so the API only ever writes safe names.
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  setup_command text,
  test_command text,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, scm_repo_id),
  UNIQUE (project_id, name)
);
CREATE INDEX project_repos_scm ON project_repos (scm_repo_id);

INSERT INTO project_repos (org_id, project_id, scm_repo_id, scm_repo_path, scm_clone_url, default_branch, name, setup_command, test_command)
SELECT
  org_id, id, scm_repo_id, scm_repo_path, scm_clone_url, default_branch,
  COALESCE(NULLIF(regexp_replace(regexp_replace(scm_repo_path, '^.*/', ''), '[^A-Za-z0-9._-]', '-', 'g'), ''), 'repo'),
  setup_command, test_command
FROM projects;

-- iid is unique only inside one repository. repo_path keeps the link readable after a repository leaves the project.
CREATE TABLE issue_merge_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  repo_id uuid REFERENCES project_repos(id) ON DELETE SET NULL,
  repo_path text NOT NULL,
  mr_id text NOT NULL,
  mr_iid integer NOT NULL,
  mr_url text NOT NULL,
  mr_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, repo_id)
);
CREATE INDEX issue_merge_requests_lookup ON issue_merge_requests (repo_id, mr_iid);

INSERT INTO issue_merge_requests (org_id, issue_id, repo_id, repo_path, mr_id, mr_iid, mr_url, mr_state)
SELECT issues.org_id, issues.id, repos.id, repos.scm_repo_path, COALESCE(issues.mr_id, ''), issues.mr_iid, COALESCE(issues.mr_url, ''), COALESCE(issues.mr_state, 'opened')
FROM issues JOIN project_repos repos ON repos.project_id = issues.project_id
WHERE issues.mr_iid IS NOT NULL;

ALTER TABLE mr_discussions ADD COLUMN repo_id uuid REFERENCES project_repos(id) ON DELETE SET NULL;
UPDATE mr_discussions SET repo_id = repos.id
FROM issues JOIN project_repos repos ON repos.project_id = issues.project_id
WHERE mr_discussions.issue_id = issues.id;

ALTER TABLE issues DROP COLUMN mr_id, DROP COLUMN mr_iid, DROP COLUMN mr_url, DROP COLUMN mr_state;
ALTER TABLE projects
  DROP COLUMN scm_repo_id, DROP COLUMN scm_repo_path, DROP COLUMN scm_clone_url,
  DROP COLUMN default_branch, DROP COLUMN setup_command, DROP COLUMN test_command;
