ALTER TABLE schedules ADD COLUMN revision bigint NOT NULL DEFAULT 1;
ALTER TABLE schedules ADD COLUMN dispatch_state text NOT NULL DEFAULT 'pending'
 CHECK(dispatch_state IN ('pending','blocked','delivered','cancelled'));
ALTER TABLE schedules ADD COLUMN blocked_reason text;
ALTER TABLE schedules ADD COLUMN delivery_seq bigint;
ALTER TABLE schedules ADD COLUMN delivery_run_id text;

-- Old disabled rows cannot distinguish a stop from a model failure. Retain
-- their evidence, but require an explicit retry instead of reviving old work.
UPDATE schedules SET
 dispatch_state=CASE WHEN spec->>'blockedReason'='model_not_configured' THEN 'blocked'
                     WHEN enabled THEN 'pending' ELSE 'cancelled' END,
 blocked_reason=CASE WHEN spec->>'blockedReason'='model_not_configured' THEN 'legacy_configuration'
                     WHEN NOT enabled THEN 'legacy_inactive' ELSE NULL END,
 enabled=CASE WHEN spec->>'blockedReason'='model_not_configured' THEN false ELSE enabled END,
 spec=spec-'blockedReason';

-- A stale legacy model failure could overwrite a completed dispatch. Preserve
-- positive delivery evidence so explicit retry cannot append that input again.
UPDATE schedules s SET
 dispatch_state=CASE WHEN m.consumed_run_id IS NULL AND m.seq<=c.consumed_message_seq
                     THEN 'cancelled' ELSE 'delivered' END,
 blocked_reason=CASE WHEN m.consumed_run_id IS NULL AND m.seq<=c.consumed_message_seq
                     THEN 'legacy_inactive' ELSE NULL END,
 delivery_seq=m.seq, delivery_run_id=coalesce(m.run_id,m.consumed_run_id)
FROM conversations c JOIN messages m ON m.conversation_id=c.id
WHERE c.agent_id=s.agent_id AND s.kind='resource_change'
 AND s.dispatch_state='blocked' AND s.blocked_reason='legacy_configuration'
 AND m.role='trigger' AND m.client_message_id='schedule-'||s.id||'-'||
   to_char(s.next_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=13;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK(version=13);
