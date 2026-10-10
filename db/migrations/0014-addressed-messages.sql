ALTER TABLE conversations ADD COLUMN identity_kind text NOT NULL DEFAULT 'workspace'
 CHECK (identity_kind IN ('workspace','agent','deleted_agent'));
UPDATE conversations SET identity_kind='agent' WHERE agent_id IS NOT NULL;
UPDATE conversations c SET identity_kind='deleted_agent' WHERE agent_id IS NULL AND EXISTS(
 SELECT 1 FROM runs r WHERE r.subject_id=c.id AND r.frozen_input->>'agentId' IS NOT NULL
);
ALTER TABLE conversations ADD COLUMN generation bigint NOT NULL DEFAULT 0;

CREATE TABLE message_requests (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id),
 message_id text NOT NULL, sender_kind text NOT NULL CHECK(sender_kind IN ('user','agent','workspace')),
 sender_conversation_id text NOT NULL REFERENCES conversations(id), sender_agent_id text,
 recipient_kind text NOT NULL CHECK(recipient_kind IN ('user','agent','workspace')),
 recipient_conversation_id text NOT NULL REFERENCES conversations(id), recipient_agent_id text,
 takeover_run_id text REFERENCES runs(id),
 origin_work_item_id text, parent_request_id text REFERENCES message_requests(id),
 cause_id text, state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','answered','declined','cancelled','unavailable')),
 work_state text NOT NULL DEFAULT 'queued' CHECK(work_state IN ('queued','active','waiting','stopped','closed')),
 reply_message_id text, blocked_reason text, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(message_id,recipient_conversation_id)
);
CREATE INDEX message_requests_inbox ON message_requests(recipient_conversation_id,state,work_state,created_at);
CREATE INDEX message_requests_origin ON message_requests(sender_conversation_id,origin_work_item_id,state);

CREATE TABLE message_dispatches (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id),
 conversation_id text NOT NULL REFERENCES conversations(id), run_id text NOT NULL REFERENCES runs(id),
 tool_call_id text REFERENCES tool_calls(id), logical_id text NOT NULL, input_hash text NOT NULL,
 origin text NOT NULL CHECK(origin IN ('tool','final','hire')),
 generation bigint NOT NULL, work_item_id text, payload jsonb NOT NULL, intent jsonb,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','waiting','sent','failed','cancelled')),
 approval_id text, result jsonb, output_handled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,logical_id)
);
CREATE INDEX messages_dispatch ON messages((content->>'messageId')) WHERE content ? 'messageId';
CREATE INDEX messages_request ON messages(conversation_id,(content->>'collaborationRequestId')) WHERE content ? 'collaborationRequestId';
CREATE INDEX message_dispatches_pending ON message_dispatches(conversation_id,state) WHERE state IN ('prepared','waiting');
ALTER TABLE approvals ADD COLUMN origin_dispatch_id text REFERENCES message_dispatches(id);
CREATE UNIQUE INDEX approvals_dispatch_pending ON approvals(origin_dispatch_id) WHERE status='pending';
ALTER TABLE tool_calls ADD COLUMN work_item_id text;
ALTER TABLE tool_calls ADD COLUMN generation bigint;
ALTER TABLE model_calls ADD COLUMN generation_id text;
ALTER TABLE model_calls ADD COLUMN work_item_id text;

CREATE FUNCTION retire_agent_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.kind='agent' THEN
  UPDATE conversations SET identity_kind='deleted_agent',generation=generation+1 WHERE agent_id=OLD.id;
  UPDATE message_requests SET state='unavailable',work_state='closed',blocked_reason='agent_deleted',version=version+1,updated_at=now()
   WHERE state='open' AND (sender_agent_id=OLD.id OR recipient_agent_id=OLD.id OR sender_conversation_id IN (SELECT id FROM conversations WHERE agent_id=OLD.id) OR recipient_conversation_id IN (SELECT id FROM conversations WHERE agent_id=OLD.id));
  UPDATE message_dispatches SET state='cancelled',updated_at=now()
   WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id=OLD.id) AND state IN ('prepared','waiting');
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER retire_agent_before_delete BEFORE DELETE ON nodes FOR EACH ROW EXECUTE FUNCTION retire_agent_conversation();


ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=14;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK(version=14);
