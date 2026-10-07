ALTER TABLE nodes DROP CONSTRAINT nodes_kind_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('text','image','pdf','group','agent','todo'));
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=8;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK (version=8);
