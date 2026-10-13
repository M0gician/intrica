ALTER TABLE message_requests RENAME TO message_deliveries;
ALTER TABLE message_deliveries ALTER COLUMN origin_call_id DROP NOT NULL;
ALTER TABLE message_deliveries ADD COLUMN source_message_id text;
ALTER TABLE message_deliveries ADD COLUMN cause_id text REFERENCES runs(id);
UPDATE message_deliveries d SET source_message_id='send-'||origin_call_id,
 cause_id=r.cause_id FROM tool_calls t JOIN runs r ON r.id=t.run_id WHERE t.id=d.origin_call_id;
ALTER TABLE message_deliveries ALTER COLUMN source_message_id SET NOT NULL;
ALTER TABLE message_deliveries ALTER COLUMN cause_id SET NOT NULL;
ALTER TABLE message_deliveries ADD COLUMN expect_reply boolean NOT NULL DEFAULT true;
ALTER TABLE message_deliveries ALTER COLUMN expect_reply SET DEFAULT false;
ALTER TABLE message_deliveries ADD COLUMN unread_deadline_at timestamptz;
UPDATE message_deliveries SET unread_deadline_at=created_at+interval '60 seconds';
ALTER TABLE message_deliveries ALTER COLUMN unread_deadline_at SET NOT NULL;
ALTER TABLE message_deliveries ADD COLUMN unread_notified_at timestamptz;
ALTER TABLE message_deliveries ADD COLUMN snoozed_until timestamptz;
ALTER TABLE message_deliveries ADD COLUMN tracking_stopped boolean NOT NULL DEFAULT false;
ALTER TABLE message_deliveries ADD COLUMN expedited_at timestamptz;
ALTER TABLE message_deliveries ADD COLUMN expedited_by text;
ALTER TABLE message_deliveries ADD COLUMN expedite_message_id text;
CREATE UNIQUE INDEX message_delivery_source ON message_deliveries(sender_conversation_id,source_message_id,recipient_conversation_id);
ALTER TABLE agent_configs ADD COLUMN paused boolean NOT NULL DEFAULT false;
ALTER TABLE agent_configs ALTER COLUMN enabled SET DEFAULT true;
ALTER TABLE inbox_reviews ADD COLUMN decisions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tool_calls ALTER COLUMN schema_version SET DEFAULT 4;
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=15;
ALTER TABLE schema_info ADD CHECK(version=15);

CREATE INDEX message_deliveries_unread_due ON message_deliveries(unread_deadline_at) WHERE state='open' AND NOT tracking_stopped AND unread_notified_at IS NULL;
