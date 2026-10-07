-- NULL is an independent owner grant; a non-NULL value is bounded by that
-- manager's current effective resources and the current management hierarchy.
ALTER TABLE grants ADD COLUMN delegated_by text;
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_subject_id_resource_id_key;
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_subject_resource_key;
ALTER TABLE grants ADD UNIQUE NULLS NOT DISTINCT(subject_id,resource_id,delegated_by);
CREATE INDEX grants_delegator ON grants(delegated_by) WHERE delegated_by IS NOT NULL;
-- Earlier Agent-created provenance used the authorization direction and a run
-- ID. Repair only verifiable conversation-run edges, preserving grant links.
UPDATE edges e SET from_id=e.to_id,to_id=e.from_id,source_attempt_id=(
  SELECT a.id FROM attempts a JOIN nodes output ON output.id=e.to_id
  WHERE a.run_id=e.source_attempt_id AND a.created_at<=output.created_at
  ORDER BY a.epoch DESC LIMIT 1
)
WHERE e.kind='derived_from'
  AND EXISTS(SELECT 1 FROM nodes creator WHERE creator.id=e.from_id AND creator.kind='agent')
  AND EXISTS(SELECT 1 FROM runs r WHERE r.id=e.source_attempt_id AND r.kind='conversation');
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK(version=7) NOT VALID;
UPDATE schema_info SET version=7;
ALTER TABLE schema_info VALIDATE CONSTRAINT schema_info_version_check;
