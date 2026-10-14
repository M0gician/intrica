ALTER TABLE conversations ADD COLUMN context_version bigint NOT NULL DEFAULT 0;
CREATE TABLE context_summaries (
 id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id),
 run_id text NOT NULL REFERENCES runs(id), request_id text NOT NULL,
 source_hash text NOT NULL, source_refs jsonb NOT NULL, instruction_hash text NOT NULL,
 content jsonb NOT NULL, previous_checkpoint jsonb NOT NULL, context_version bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,context_version)
);
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=17;
ALTER TABLE schema_info ADD CHECK(version=17);

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

-- Seal operations that never started. Completed receipts, bytes and authority stay intact.
UPDATE approvals SET status='invalidated',version=version+1 WHERE status='pending'
 AND origin_call_id IN (SELECT id FROM tool_calls WHERE schema_version<6 AND state IN ('prepared','waiting'));
UPDATE tool_calls SET state='failed',completed_at=now(),updated_at=now(),result=jsonb_build_object(
 'isError',true,'details','{}'::jsonb,'content',jsonb_build_array(jsonb_build_object('type','text','text',
 jsonb_build_object('effect','none','error',jsonb_build_object('code','TOOL_CONTRACT_REPLACED','message','Unstarted call sealed; replan with the current tools / 旧调用尚未执行，已封存，请按当前工具重新规划'))::text)))
 WHERE schema_version<6 AND state IN ('prepared','waiting');
UPDATE tool_calls SET state='unknown',updated_at=now() WHERE schema_version<6 AND state='dispatching' AND effect_class<>'read';

UPDATE runs SET reason='progress_review' WHERE state='waiting' AND reason='inbox_review';
