ALTER TABLE tool_calls ADD COLUMN schema_version integer NOT NULL DEFAULT 2;
ALTER TABLE tool_calls ALTER COLUMN schema_version SET DEFAULT 3;
CREATE TABLE message_requests (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id),
 sender_conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 recipient_conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 sender_agent_id text, recipient_agent_id text NOT NULL,
 origin_call_id text NOT NULL REFERENCES tool_calls(id), inbox_message_id text NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','replied','cancelled')),
 deadline_at timestamptz NOT NULL, notified_at timestamptz,
 version integer NOT NULL DEFAULT 1, notice_count integer NOT NULL DEFAULT 0,
 reply_call_id text REFERENCES tool_calls(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(origin_call_id,recipient_conversation_id)
);
CREATE INDEX message_requests_due ON message_requests(deadline_at) WHERE state='open' AND notified_at IS NULL;
CREATE TABLE inbox_reviews (
 conversation_id text PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 token text NOT NULL, fingerprint text NOT NULL, inspection_token text, inspection_fingerprint text, reviewed_seq bigint NOT NULL DEFAULT 0, reviewed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=14;
ALTER TABLE schema_info ADD CHECK(version=14);
