-- Smaller models an agent may hand parts of its work to, inside its own run.
ALTER TABLE agents ADD COLUMN helpers jsonb NOT NULL DEFAULT '[]';
