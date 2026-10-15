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
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=18;
ALTER TABLE schema_info ADD CHECK(version=18);

-- Seal operations that never started. Completed receipts, bytes and authority stay intact.
UPDATE approvals SET status='invalidated',version=version+1 WHERE status='pending'
 AND origin_call_id IN (SELECT id FROM tool_calls WHERE schema_version<7 AND state IN ('prepared','waiting'));
UPDATE tool_calls SET state='failed',completed_at=now(),updated_at=now(),result=jsonb_build_object(
 'isError',true,'details','{}'::jsonb,'content',jsonb_build_array(jsonb_build_object('type','text','text',
 jsonb_build_object('effect','none','error',jsonb_build_object('code','TOOL_CONTRACT_REPLACED','message','Unstarted call sealed; replan with the current tools / 旧调用尚未执行，已封存，请按当前工具重新规划'))::text)))
 WHERE schema_version<7 AND state IN ('prepared','waiting');
UPDATE tool_calls SET state='unknown',updated_at=now() WHERE schema_version<7 AND state='dispatching' AND effect_class<>'read';


UPDATE agent_configs SET config=config-'saveMemoryBeforeCompaction' WHERE config ? 'saveMemoryBeforeCompaction';
