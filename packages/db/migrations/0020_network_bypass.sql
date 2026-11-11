-- Hosts an agent's or preview's tools reach without the egress proxy, for names that only exist inside the run.
ALTER TABLE projects ADD COLUMN network_bypass jsonb NOT NULL DEFAULT '[]';
