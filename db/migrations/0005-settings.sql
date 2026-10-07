CREATE TABLE execution_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), revision integer NOT NULL DEFAULT 1,
 policy jsonb NOT NULL, initialized_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_endpoints (
 id text PRIMARY KEY, name text NOT NULL, base_url text NOT NULL,
 credential_ref text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 1
);
INSERT INTO model_endpoints(id,name,base_url,credential_ref)
 SELECT id,coalesce(public_config->>'name',id),public_config->>'baseUrl',credential_ref FROM model_profiles;
ALTER TABLE model_profiles ADD COLUMN endpoint_id text REFERENCES model_endpoints(id) ON DELETE CASCADE;
UPDATE model_profiles SET endpoint_id=id,public_config=public_config-'baseUrl'-'hasKey'-'reuseFromId';
ALTER TABLE model_profiles DROP COLUMN credential_ref;
CREATE TABLE model_calls (
 id text PRIMARY KEY, run_id text, attempt_id text, canvas_id text, conversation_id text,
 endpoint_id text, profile_id text, provider text NOT NULL, model_id text NOT NULL, protocol text NOT NULL,
 purpose text NOT NULL, simulated boolean NOT NULL DEFAULT false,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 outcome text NOT NULL DEFAULT 'unconfirmed', usage_status text NOT NULL DEFAULT 'unavailable',
 input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint
);
CREATE INDEX model_calls_time ON model_calls(started_at);
CREATE INDEX model_calls_canvas_time ON model_calls(canvas_id,started_at);
ALTER TABLE schema_info DROP CONSTRAINT IF EXISTS schema_info_version_check;
UPDATE schema_info SET version=5;
ALTER TABLE schema_info ADD CHECK(version=5);

ALTER TABLE schema_info ADD COLUMN models_initialized boolean NOT NULL DEFAULT false;
