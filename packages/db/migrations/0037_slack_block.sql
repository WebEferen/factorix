-- Sending to Slack belongs to the Slack integration now, under a type of its own. Drafts, published copies, and the
-- copies runs keep all move with it, so a run in progress still finds its handler.
CREATE FUNCTION pg_temp.slack_block(definition jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_set(definition, '{nodes}', (
    SELECT jsonb_agg(CASE WHEN node->>'type' = 'notify.send' THEN jsonb_set(node, '{type}', '"slack.send_message"') ELSE node END ORDER BY position)
    FROM jsonb_array_elements(definition->'nodes') WITH ORDINALITY AS nodes(node, position)
  ))
$$;

UPDATE workflows SET definition = pg_temp.slack_block(definition) WHERE definition->'nodes' @> '[{"type": "notify.send"}]';
UPDATE workflows SET published_definition = pg_temp.slack_block(published_definition)
  WHERE published_definition->'nodes' @> '[{"type": "notify.send"}]';
UPDATE workflow_runs SET definition = pg_temp.slack_block(definition) WHERE definition->'nodes' @> '[{"type": "notify.send"}]';
UPDATE workflow_steps SET block = 'slack.send_message' WHERE block = 'notify.send';
