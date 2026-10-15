-- Intrica protocol 2. This schema never reads or alters the previous public tables.
CREATE TABLE IF NOT EXISTS schema_info (version integer PRIMARY KEY CHECK (version=18), models_initialized boolean NOT NULL DEFAULT false);
INSERT INTO schema_info(version) VALUES (18) ON CONFLICT DO NOTHING;
CREATE TABLE canvases (
 id text PRIMARY KEY, title text NOT NULL, graph_revision integer NOT NULL DEFAULT 0,
 event_seq bigint NOT NULL DEFAULT 0,
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assets (
 id text PRIMARY KEY, content_hash text NOT NULL UNIQUE, storage_key text NOT NULL,
 mime text NOT NULL, bytes integer NOT NULL, width integer NOT NULL, height integer NOT NULL,
 last_used_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL CHECK (state IN ('ready','deleting')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE nodes (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), parent_id text,
 sort_key bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('text','image','pdf','group','agent','todo')),
 body jsonb NOT NULL, x double precision NOT NULL, y double precision NOT NULL,
 w double precision NOT NULL CHECK(w>0), h double precision NOT NULL CHECK(h>0),
 content_version integer NOT NULL DEFAULT 1, layout_version integer NOT NULL DEFAULT 1,
 origin text NOT NULL DEFAULT 'user' CHECK(origin IN ('user','model')),
 asset_id text REFERENCES assets(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(canvas_id,id), FOREIGN KEY(canvas_id,parent_id) REFERENCES nodes(canvas_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(parent_id IS DISTINCT FROM id)
);
CREATE INDEX nodes_parent ON nodes(canvas_id,parent_id,sort_key,id);
CREATE TABLE edges (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), from_id text NOT NULL, to_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('user_link','derived_from')), version integer NOT NULL DEFAULT 1,
 source_attempt_id text, source_revision integer,
 FOREIGN KEY(canvas_id,from_id) REFERENCES nodes(canvas_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(canvas_id,to_id) REFERENCES nodes(canvas_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(from_id<>to_id)
);
CREATE INDEX edges_from ON edges(canvas_id,from_id);
CREATE INDEX edges_to ON edges(canvas_id,to_id);
CREATE UNIQUE INDEX user_links ON edges(canvas_id,least(from_id,to_id),greatest(from_id,to_id)) WHERE kind='user_link';
CREATE UNIQUE INDEX provenance ON edges(source_attempt_id,from_id,to_id) WHERE kind='derived_from';
CREATE TABLE commands (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), actor_id text NOT NULL,
 command_key text NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
 undo_patch jsonb, undone boolean NOT NULL DEFAULT false, kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(canvas_id,actor_id,command_key)
);
CREATE INDEX commands_key ON commands(actor_id,command_key);
CREATE INDEX commands_history ON commands(canvas_id,actor_id,created_at DESC);
CREATE TABLE canvas_events (
 canvas_id text NOT NULL REFERENCES canvases(id), seq bigint NOT NULL, type text NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(canvas_id,seq)
);
CREATE TABLE agent_configs (
 node_id text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
 config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, paused boolean NOT NULL DEFAULT false
);
CREATE TABLE conversations (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), agent_id text UNIQUE REFERENCES agent_configs(node_id) ON DELETE SET NULL,
 message_seq bigint NOT NULL DEFAULT 0, consumed_message_seq bigint NOT NULL DEFAULT 0,
 checkpoint jsonb NOT NULL DEFAULT '[]', context jsonb, model jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, seq bigint NOT NULL,
 client_message_id text NOT NULL, role text NOT NULL, content jsonb NOT NULL,
 run_id text, consumed_run_id text, consumed_at timestamptz, expedite_requested_at timestamptz, expedite_run_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,seq),
 UNIQUE(conversation_id,client_message_id)
);
CREATE TABLE runs (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), subject_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('generation','conversation')),
 state text NOT NULL CHECK(state IN ('queued','running','waiting','succeeded','failed','cancelled')),
 available_at timestamptz NOT NULL DEFAULT now(), owner_id text, epoch integer NOT NULL DEFAULT 0,
 lease_until timestamptz, cancel_requested_at timestamptz, frozen_input jsonb NOT NULL,
 last_event_seq bigint NOT NULL DEFAULT 0, cause_id text NOT NULL, activation_count integer NOT NULL DEFAULT 0,
 reason text, superseded_by_run_id text REFERENCES runs(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_handoffs ON runs(superseded_by_run_id) WHERE superseded_by_run_id IS NOT NULL;
CREATE UNIQUE INDEX conversation_slot ON runs(subject_id) WHERE kind='conversation' AND state IN ('queued','running','waiting');
CREATE INDEX runs_ready ON runs(available_at,created_at,id) WHERE state='queued';
CREATE INDEX runs_leases ON runs(lease_until) WHERE state='running';
CREATE INDEX runs_canvas ON runs(canvas_id,kind,created_at DESC);
CREATE INDEX runs_subject ON runs(subject_id,created_at DESC);
CREATE TABLE attempts (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), epoch integer NOT NULL,
 state text NOT NULL CHECK(state IN ('running','succeeded','failed','expired','cancelled','waiting')),
 provider_request_id text, failure text, created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 UNIQUE(run_id,epoch)
);
CREATE TABLE run_events (
 run_id text NOT NULL REFERENCES runs(id), seq bigint NOT NULL, attempt_id text REFERENCES attempts(id),
 type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,seq)
);
CREATE TABLE proposals (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), run_id text NOT NULL UNIQUE REFERENCES runs(id),
 attempt_id text NOT NULL UNIQUE REFERENCES attempts(id), items jsonb NOT NULL, decisions jsonb NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_canvas ON proposals(canvas_id,created_at DESC);
CREATE TABLE tool_calls (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), attempt_id text NOT NULL REFERENCES attempts(id),
 schema_version integer NOT NULL DEFAULT 5,
 logical_call_id text NOT NULL, name text NOT NULL, args jsonb NOT NULL, args_hash text NOT NULL,
 effect_class text NOT NULL CHECK(effect_class IN ('read','graph','external')),
 state text NOT NULL CHECK(state IN ('prepared','dispatching','succeeded','failed','unknown','waiting')),
 is_async boolean NOT NULL DEFAULT false, delivered_at timestamptz, next_notice_at timestamptz, notice_count integer NOT NULL DEFAULT 0,
 result jsonb, approval_id text, execution_input jsonb, dispatched_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,logical_call_id)
);
CREATE INDEX tool_calls_pending ON tool_calls(run_id) WHERE is_async AND delivered_at IS NULL;
CREATE INDEX tool_calls_dispatching ON tool_calls(run_id) WHERE state='dispatching';
CREATE TABLE grants (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), subject_id text NOT NULL REFERENCES agent_configs(node_id) ON DELETE CASCADE,
 resource_id text NOT NULL, mode text NOT NULL CHECK(mode IN ('read','write')),
 execution_mode text NOT NULL DEFAULT 'none' CHECK(execution_mode IN ('none','isolated','host')),
 source_link_id text NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
 version integer NOT NULL DEFAULT 1, delegated_by text, UNIQUE NULLS NOT DISTINCT(subject_id,resource_id,delegated_by)
);
CREATE INDEX grants_delegator ON grants(delegated_by) WHERE delegated_by IS NOT NULL;
CREATE TABLE approvals (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), subject_id text NOT NULL,
 origin_call_id text REFERENCES tool_calls(id), action jsonb NOT NULL,
 complete_tool boolean NOT NULL DEFAULT false, basis jsonb NOT NULL, execution_basis jsonb,
 status text NOT NULL CHECK(status IN ('pending','approved','satisfied','denied','cancelled','expired','invalidated')),
 version integer NOT NULL DEFAULT 1, assigned_reviewer_id text, review_due_at timestamptz,
 route_reason text NOT NULL DEFAULT 'user', expires_at timestamptz NOT NULL,
 decided_by text, reason text NOT NULL, decision text, decided_at timestamptz, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approvals_call_pending ON approvals(origin_call_id) WHERE status='pending';
CREATE INDEX approvals_review ON approvals(canvas_id,assigned_reviewer_id,status,created_at,id);
CREATE INDEX approvals_due ON approvals(expires_at,review_due_at) WHERE status='pending';
CREATE TABLE schedules (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), agent_id text NOT NULL REFERENCES agent_configs(node_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('cron','resource_change')), next_due_at timestamptz NOT NULL,
 timezone text NOT NULL DEFAULT 'UTC', spec jsonb NOT NULL, dedupe_key text NOT NULL UNIQUE,
 enabled boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1,
 dispatch_state text NOT NULL DEFAULT 'pending' CHECK(dispatch_state IN ('pending','blocked','delivered','cancelled')),
 blocked_reason text, delivery_seq bigint, delivery_run_id text
);
CREATE INDEX schedules_due ON schedules(next_due_at) WHERE enabled;
CREATE TABLE model_endpoints (
 id text PRIMARY KEY, name text NOT NULL, base_url text NOT NULL,
 credential_ref text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 1
);
CREATE TABLE model_profiles (
 id text PRIMARY KEY, version integer NOT NULL DEFAULT 1, public_config jsonb NOT NULL,
 endpoint_id text REFERENCES model_endpoints(id) ON DELETE CASCADE, selected boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX selected_model ON model_profiles(selected) WHERE selected;

CREATE TABLE execution_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), revision integer NOT NULL DEFAULT 1,
 policy jsonb NOT NULL, initialized_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_calls (
 id text PRIMARY KEY, run_id text, attempt_id text, canvas_id text, conversation_id text,
 endpoint_id text, profile_id text, provider text NOT NULL, model_id text NOT NULL, protocol text NOT NULL,
 purpose text NOT NULL, simulated boolean NOT NULL DEFAULT false,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 provider_request_id text, response_id text, request_id text, first_response_at timestamptz,
 last_response_at timestamptz, response_phase text NOT NULL DEFAULT 'awaiting_response',
 outcome text NOT NULL DEFAULT 'unconfirmed', usage_status text NOT NULL DEFAULT 'unavailable',
 input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint
);
CREATE INDEX model_calls_time ON model_calls(started_at);
CREATE INDEX model_calls_canvas_time ON model_calls(canvas_id,started_at);

CREATE TABLE media_references (
 id text PRIMARY KEY, asset_id text NOT NULL REFERENCES assets(id),
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 tool_call_id text REFERENCES tool_calls(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT(asset_id,conversation_id,tool_call_id)
);
CREATE INDEX media_references_scope ON media_references(conversation_id);

CREATE TABLE message_deliveries (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id),
 sender_conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 recipient_conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 sender_agent_id text, recipient_agent_id text NOT NULL,
 origin_call_id text REFERENCES tool_calls(id), inbox_message_id text NOT NULL,
 source_message_id text NOT NULL, cause_id text NOT NULL REFERENCES runs(id),
 expect_reply boolean NOT NULL DEFAULT false, unread_deadline_at timestamptz NOT NULL,
 unread_notified_at timestamptz, snoozed_until timestamptz, tracking_stopped boolean NOT NULL DEFAULT false,
 expedited_at timestamptz, expedited_by text, expedite_message_id text,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','replied','cancelled')),
 deadline_at timestamptz NOT NULL, notified_at timestamptz,
 version integer NOT NULL DEFAULT 1, notice_count integer NOT NULL DEFAULT 0,
 reply_call_id text REFERENCES tool_calls(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(sender_conversation_id,source_message_id,recipient_conversation_id)
);
CREATE INDEX message_deliveries_due ON message_deliveries(deadline_at) WHERE state='open' AND notified_at IS NULL;
CREATE TABLE inbox_reviews (
 conversation_id text PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 token text NOT NULL, fingerprint text NOT NULL, inspection_token text, inspection_fingerprint text, reviewed_seq bigint NOT NULL DEFAULT 0, reviewed_at timestamptz NOT NULL DEFAULT now(), decisions jsonb NOT NULL DEFAULT '[]'
);

CREATE INDEX message_deliveries_unread_due ON message_deliveries(unread_deadline_at) WHERE state='open' AND NOT tracking_stopped AND unread_notified_at IS NULL;

ALTER TABLE conversations ADD COLUMN context_version bigint NOT NULL DEFAULT 0;
CREATE TABLE context_summaries (
 id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id),
 run_id text NOT NULL REFERENCES runs(id), request_id text NOT NULL,
 source_hash text NOT NULL, source_refs jsonb NOT NULL, instruction_hash text NOT NULL,
 content jsonb NOT NULL, previous_checkpoint jsonb NOT NULL, context_version bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,context_version)
);

CREATE TABLE message_dispositions (
 conversation_id text NOT NULL REFERENCES conversations(id), item_id text NOT NULL, revision text NOT NULL,
 action text NOT NULL CHECK(action in ('background','handled')), reason text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(conversation_id,item_id)
);
CREATE SEQUENCE mailbox_ref_seq;
CREATE TABLE mailbox_refs (
 conversation_id text NOT NULL REFERENCES conversations(id), item_id text NOT NULL,
 ref text NOT NULL DEFAULT ('m'||nextval('mailbox_ref_seq')::text),
 PRIMARY KEY(conversation_id,item_id), UNIQUE(conversation_id,ref)
);
CREATE TABLE mailbox_pages (
 id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), item_ids text[] NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour'
);
CREATE TABLE progress_reviews (
 conversation_id text PRIMARY KEY REFERENCES conversations(id), run_id text NOT NULL REFERENCES runs(id),
 outcome text NOT NULL CHECK(outcome in ('completed','continue','waiting','blocked')), reason text NOT NULL, remaining_work text,
 dependency_ids text[] NOT NULL, evidence_refs text[] NOT NULL, delivery_call_ids text[] NOT NULL,
 execution_hash text NOT NULL DEFAULT '', input_boundary text NOT NULL, instruction_hash text NOT NULL, obligations jsonb NOT NULL, reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_quota_groups (
 id text PRIMARY KEY, capacity integer NOT NULL DEFAULT 4 CHECK(capacity between 1 and 1000), cooldown_until timestamptz
);
ALTER TABLE model_endpoints ADD COLUMN quota_group_id text REFERENCES model_quota_groups(id);
CREATE TABLE model_requests (
 id text PRIMARY KEY, run_id text REFERENCES runs(id), conversation_id text NOT NULL, purpose text NOT NULL,
 group_id text NOT NULL REFERENCES model_quota_groups(id), source_hash text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state in ('queued','leased','streaming','retry_wait','succeeded','failed','cancelled')),
 owner text, lease_until timestamptz, first_failure_at timestamptz, attempts integer NOT NULL DEFAULT 0, reason text,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), response jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX model_request_queue ON model_requests(group_id,next_attempt_at) WHERE state in ('queued','retry_wait','leased','streaming');
CREATE TABLE model_fairness (group_id text NOT NULL REFERENCES model_quota_groups(id), conversation_id text NOT NULL, served_at timestamptz NOT NULL, PRIMARY KEY(group_id,conversation_id));

CREATE TABLE read_cursors (
 id text PRIMARY KEY, canvas_id text NOT NULL REFERENCES canvases(id), conversation_id text NOT NULL REFERENCES conversations(id),
 target jsonb NOT NULL, input jsonb NOT NULL, source_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour'
);
CREATE INDEX read_cursor_owner ON read_cursors(conversation_id,created_at);

ALTER TABLE tool_calls ALTER COLUMN schema_version SET DEFAULT 6;

ALTER TABLE context_summaries ADD COLUMN source_messages jsonb NOT NULL DEFAULT '[]';
ALTER TABLE context_summaries ADD COLUMN access_scope jsonb;
ALTER TABLE model_requests ADD COLUMN validation_failures integer NOT NULL DEFAULT 0;
ALTER TABLE model_requests ADD COLUMN validation_feedback text;
CREATE TABLE model_response_validations (
 request_id text NOT NULL REFERENCES model_requests(id) ON DELETE CASCADE,
 attempt integer NOT NULL, status text NOT NULL CHECK(status IN ('accepted','rejected')),
 issue text, stop_reason text NOT NULL, output_chars integer NOT NULL,
 output_hash text NOT NULL, output_excerpt text NOT NULL CHECK(length(output_excerpt)<=16000),
 output_truncated boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(request_id,attempt)
);
CREATE TABLE read_observations (
 tool_call_id text PRIMARY KEY REFERENCES tool_calls(id) ON DELETE CASCADE,
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 source_key text NOT NULL, target jsonb NOT NULL, source_version text NOT NULL,
 position jsonb NOT NULL, next_cursor text, content_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX read_observations_source ON read_observations(conversation_id,source_key,created_at DESC);
ALTER TABLE tool_calls ALTER COLUMN schema_version SET DEFAULT 7;
