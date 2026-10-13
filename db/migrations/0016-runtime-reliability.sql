ALTER TABLE model_calls ADD COLUMN last_response_at timestamptz;
ALTER TABLE model_calls ADD COLUMN response_phase text NOT NULL DEFAULT 'awaiting_response';
ALTER TABLE tool_calls ALTER COLUMN schema_version SET DEFAULT 5;
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=16;
ALTER TABLE schema_info ADD CHECK(version=16);
