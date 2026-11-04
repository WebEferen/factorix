-- What the SDKs in the sandbox image offer. Global, because it follows the image, not an org.
CREATE TABLE runtime_models (
  runtime text PRIMARY KEY,
  default_model text,
  models jsonb NOT NULL DEFAULT '[]',
  fetched_at timestamptz NOT NULL DEFAULT now()
);
