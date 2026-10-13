ALTER TABLE assets ADD COLUMN IF NOT EXISTS last_used_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS provider_request_id text;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS response_id text;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS first_response_at timestamptz;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS completed_at timestamptz;
CREATE TABLE IF NOT EXISTS media_references (
 id text PRIMARY KEY, asset_id text NOT NULL REFERENCES assets(id),
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 tool_call_id text REFERENCES tool_calls(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT(asset_id,conversation_id,tool_call_id)
);
CREATE INDEX IF NOT EXISTS media_references_scope ON media_references(conversation_id);
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=12;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK(version=12);
