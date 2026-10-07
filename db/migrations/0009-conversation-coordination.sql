ALTER TABLE runs ADD COLUMN superseded_by_run_id text REFERENCES runs(id);
ALTER TABLE messages ADD COLUMN consumed_run_id text;
CREATE INDEX runs_handoffs ON runs(superseded_by_run_id) WHERE superseded_by_run_id IS NOT NULL;
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=9;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK (version=9);
