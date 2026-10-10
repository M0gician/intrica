ALTER TABLE conversations ADD COLUMN context_seq bigint NOT NULL DEFAULT 0;
CREATE TABLE context_entries (
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 seq bigint NOT NULL, content_hash text NOT NULL, message jsonb NOT NULL,
 provenance jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(conversation_id,seq)
);
CREATE TABLE inference_requests (
 id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE, work_item_id text,
 decision_revision bigint NOT NULL, state text NOT NULL DEFAULT 'prepared'
 CHECK(state IN('prepared','streaming','cutting','settling','sealed')),
 reason text, created_at timestamptz NOT NULL DEFAULT now(), sealed_at timestamptz
);
CREATE UNIQUE INDEX inference_requests_open ON inference_requests(conversation_id) WHERE state<>'sealed';
CREATE TABLE inference_attempts (
 id text PRIMARY KEY, request_id text NOT NULL REFERENCES inference_requests(id) ON DELETE CASCADE,
 lease_epoch bigint NOT NULL, ordinal integer NOT NULL, context_seq bigint NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','streaming','cutting','settling','sealed')),
 capabilities jsonb NOT NULL, manifest jsonb NOT NULL, dispatched_at timestamptz,
 cutover_at timestamptz, settle_deadline timestamptz, sealed_at timestamptz, outcome text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(request_id,ordinal)
);
CREATE UNIQUE INDEX inference_attempts_open ON inference_attempts(request_id) WHERE state<>'sealed';
CREATE TABLE inference_items (
 id text PRIMARY KEY, attempt_id text NOT NULL REFERENCES inference_attempts(id) ON DELETE CASCADE,
 ordinal integer NOT NULL, kind text NOT NULL,
 state text NOT NULL CHECK(state IN('streaming','closed','committed','discarded')),
 version integer NOT NULL DEFAULT 1, protocol_group text,
 payload jsonb NOT NULL, publication jsonb NOT NULL DEFAULT '{}', context_seq bigint, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(attempt_id,ordinal)
);
ALTER TABLE tool_calls ADD COLUMN inference_item_id text REFERENCES inference_items(id);
ALTER TABLE tool_calls ADD COLUMN primary_response jsonb;
ALTER TABLE model_calls ADD COLUMN inference_attempt_id text REFERENCES inference_attempts(id);
ALTER TABLE messages ADD COLUMN cutover_request_id text REFERENCES inference_requests(id);
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=16;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK(version=16);
