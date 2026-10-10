ALTER TABLE grants ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'none' CHECK(execution_mode IN ('none','isolated','host'));
-- Only the explicit legacy combined request proves ongoing host authority.
UPDATE grants g SET execution_mode='host'
FROM nodes n, approvals a, tool_calls t
WHERE n.id=g.resource_id AND a.origin_call_id=t.id AND a.subject_id=g.subject_id
  AND a.canvas_id=g.canvas_id AND a.status='approved' AND a.action->>'kind'='path'
  AND a.action->>'path'=n.body->'resource'->>'path'
  AND t.args->'scope'->>'access'='directory_and_commands'
  AND g.delegated_by IS NOT DISTINCT FROM nullif(a.decided_by,'owner');
UPDATE approvals a SET action=action||'{"mode":"write","execution":"host"}'::jsonb
FROM tool_calls t WHERE a.origin_call_id=t.id AND a.action->>'kind'='path'
  AND t.args->'scope'->>'access'='directory_and_commands';
ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK(status IN ('pending','approved','satisfied','denied','cancelled','expired','invalidated'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expedite_requested_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expedite_run_id text;
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=11;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK(version=11);
