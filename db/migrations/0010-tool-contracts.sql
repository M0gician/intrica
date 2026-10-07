ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=10;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK (version=10);
