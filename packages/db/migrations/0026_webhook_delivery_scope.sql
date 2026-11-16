-- A delivery id belongs to the connection that received it. Without a header it is a hash of the body, which two organizations can share.
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_source_delivery_id_key;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_connection_delivery_key UNIQUE (connection_id, delivery_id);
