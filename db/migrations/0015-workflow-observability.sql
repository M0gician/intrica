ALTER TABLE tool_calls ADD COLUMN audit jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tool_calls ADD COLUMN retry_of text REFERENCES tool_calls(id);
ALTER TABLE tool_calls ADD COLUMN model_call_id text REFERENCES model_calls(id);
ALTER TABLE tool_calls DROP CONSTRAINT tool_calls_effect_class_check;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_effect_class_check CHECK(effect_class IN ('none','read','graph','external'));
CREATE INDEX tool_calls_repairs ON tool_calls(run_id,work_item_id,(audit->>'errorFingerprint')) WHERE audit ? 'errorFingerprint';

ALTER TABLE model_calls ADD COLUMN manifest jsonb NOT NULL DEFAULT '{}';
ALTER TABLE model_calls ADD COLUMN diagnostics jsonb;
ALTER TABLE model_calls ADD COLUMN diagnostics_expires_at timestamptz;
CREATE INDEX model_diagnostics_expiry ON model_calls(diagnostics_expires_at) WHERE diagnostics_expires_at IS NOT NULL;
CREATE TABLE model_tool_observations (
 id text PRIMARY KEY, model_call_id text NOT NULL REFERENCES model_calls(id) ON DELETE CASCADE,
 content_index integer NOT NULL, provider_call_id text, name text,
 argument_hash text, parsed_type text, parse_error jsonb, diagnostics jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(model_call_id,content_index)
);
ALTER TABLE tool_calls ADD COLUMN observation_id text REFERENCES model_tool_observations(id);

ALTER TABLE model_calls ADD COLUMN manifest_expires_at timestamptz;
CREATE INDEX model_manifest_expiry ON model_calls(manifest_expires_at) WHERE manifest_expires_at IS NOT NULL;
ALTER TABLE model_tool_observations ADD COLUMN raw_argument_hash text;
CREATE TABLE diagnostic_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), revision integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,
 retention_days integer NOT NULL DEFAULT 7 CHECK(retention_days BETWEEN 1 AND 90),
 manifest_days integer NOT NULL DEFAULT 30 CHECK(manifest_days BETWEEN 1 AND 365)
);
INSERT INTO diagnostic_settings(id) VALUES(true);

ALTER TABLE message_requests ADD COLUMN lifetime text NOT NULL DEFAULT 'exclusive' CHECK(lifetime IN('exclusive','independent'));
ALTER TABLE message_requests ADD COLUMN followup_count integer NOT NULL DEFAULT 0 CHECK(followup_count>=0);
CREATE TABLE request_dependencies (
 parent_id text NOT NULL REFERENCES message_requests(id) ON DELETE CASCADE,
 child_id text NOT NULL REFERENCES message_requests(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
 PRIMARY KEY(parent_id,child_id), CHECK(parent_id<>child_id)
);
INSERT INTO request_dependencies(parent_id,child_id)
 SELECT origin_work_item_id,id FROM message_requests WHERE origin_work_item_id IS NOT NULL AND origin_work_item_id<>id;
CREATE TABLE message_waits (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 work_item_id text REFERENCES message_requests(id) ON DELETE CASCADE,
 run_id text NOT NULL REFERENCES runs(id), tool_call_id text UNIQUE REFERENCES tool_calls(id),
 generation bigint NOT NULL, mode text NOT NULL CHECK(mode IN('requests','external','idle')),
 request_ids text[] NOT NULL DEFAULT '{}', baseline_seq bigint NOT NULL,
 deadline timestamptz, state text NOT NULL DEFAULT 'active' CHECK(state IN('active','released','cancelled')),
 release_reason text, blocked_reason text, notice_seq bigint,
 created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE UNIQUE INDEX message_waits_active ON message_waits(conversation_id,coalesce(work_item_id,'')) WHERE state='active';
CREATE INDEX message_waits_due ON message_waits(deadline) WHERE state='active';
CREATE TABLE message_followups (
 request_id text NOT NULL REFERENCES message_requests(id) ON DELETE CASCADE,
 message_id text NOT NULL REFERENCES message_dispatches(id), wait_window text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(request_id,wait_window), UNIQUE(message_id)
);
ALTER TABLE conversations ADD COLUMN last_agent_expedite_at timestamptz;

CREATE TABLE execution_environments (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
 creator_agent_id text, label text NOT NULL, interpreter text NOT NULL, cwd text NOT NULL,
 instructions text NOT NULL, fingerprint text NOT NULL, verification jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_environments_canvas ON execution_environments(canvas_id,created_at);

ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=15;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK(version=15);
