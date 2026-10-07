-- Legacy pending approvals lack an execution identity. End them without replay.
UPDATE tool_calls SET state='failed',result='{"content":[{"type":"text","text":"审批协议已升级，请重新发起操作 / Approval protocol upgraded; submit the operation again."}],"details":{},"isError":true}',delivered_at=null
WHERE state='waiting' AND approval_id IS NOT NULL;
UPDATE runs SET state='queued',reason=null,available_at=now()
WHERE state='waiting' AND reason='approval' AND cancel_requested_at IS NULL;
ALTER TABLE tool_calls ADD COLUMN execution_input jsonb;
ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
UPDATE approvals SET status=CASE WHEN status='used' THEN 'approved' WHEN status IN('pending','revoked') THEN 'cancelled' ELSE status END;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK(status IN('pending','approved','denied','cancelled','expired','invalidated'));
ALTER TABLE approvals ADD COLUMN origin_call_id text REFERENCES tool_calls(id);
ALTER TABLE approvals ADD COLUMN complete_tool boolean NOT NULL DEFAULT false;
ALTER TABLE approvals ADD COLUMN basis jsonb NOT NULL DEFAULT '{}';
ALTER TABLE approvals ADD COLUMN execution_basis jsonb;
ALTER TABLE approvals ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE approvals ADD COLUMN assigned_reviewer_id text;
ALTER TABLE approvals ADD COLUMN review_due_at timestamptz;
ALTER TABLE approvals ADD COLUMN route_reason text NOT NULL DEFAULT 'user';
ALTER TABLE approvals ADD COLUMN decided_at timestamptz;
ALTER TABLE approvals ADD COLUMN result jsonb;
ALTER TABLE approvals RENAME COLUMN reviewer TO decided_by;
ALTER TABLE approvals DROP COLUMN policy_revision;
DROP INDEX approvals_action;
DROP INDEX approvals_pending;
CREATE UNIQUE INDEX approvals_call_pending ON approvals(origin_call_id) WHERE status='pending';
CREATE INDEX approvals_review ON approvals(canvas_id,assigned_reviewer_id,status,created_at,id);
CREATE INDEX approvals_due ON approvals(expires_at,review_due_at) WHERE status='pending';
-- Keep legacy decisions as history, with no callable effect.
UPDATE approvals SET action=jsonb_build_object('kind','legacy','previous',action),route_reason='upgraded';
ALTER TABLE grants DROP COLUMN parent_grant_id;
ALTER TABLE grants DROP CONSTRAINT grants_subject_id_resource_id_mode_key;
DELETE FROM grants WHERE revoked_at IS NOT NULL;
-- One current authorization per Agent/resource, preserving the strongest existing mode.
UPDATE grants SET mode='read' WHERE mode='execute';
WITH strongest AS (
 SELECT subject_id,resource_id,bool_or(mode='write') AS writable FROM grants GROUP BY subject_id,resource_id
), keep AS (
 SELECT DISTINCT ON(subject_id,resource_id) id,subject_id,resource_id FROM grants ORDER BY subject_id,resource_id,(source_link_id IS NOT NULL) DESC,id
)
UPDATE grants g SET mode=CASE WHEN s.writable THEN 'write' ELSE 'read' END
FROM strongest s,keep k WHERE g.id=k.id AND k.subject_id=s.subject_id AND k.resource_id=s.resource_id;
DELETE FROM grants g USING grants keep WHERE g.subject_id=keep.subject_id AND g.resource_id=keep.resource_id
 AND ( (g.source_link_id IS NULL AND keep.source_link_id IS NOT NULL) OR ((g.source_link_id IS NULL)=(keep.source_link_id IS NULL) AND g.id>keep.id));
-- Old resource approvals without a visible connection receive an explicit authorization edge.
INSERT INTO edges(id,canvas_id,from_id,to_id,kind)
SELECT 'authorization-'||g.id,g.canvas_id,g.subject_id,g.resource_id,'user_link'
FROM grants g JOIN nodes n ON n.id=g.resource_id WHERE g.source_link_id IS NULL AND g.subject_id<>g.resource_id ON CONFLICT DO NOTHING;
UPDATE grants g SET source_link_id=e.id FROM edges e WHERE g.source_link_id IS NULL AND e.kind='user_link' AND least(e.from_id,e.to_id)=least(g.subject_id,g.resource_id) AND greatest(e.from_id,e.to_id)=greatest(g.subject_id,g.resource_id);
DELETE FROM grants WHERE source_link_id IS NULL;
ALTER TABLE grants ADD CONSTRAINT grants_subject_resource_key UNIQUE(subject_id,resource_id);
ALTER TABLE grants DROP CONSTRAINT grants_mode_check;
ALTER TABLE grants ADD CONSTRAINT grants_mode_check CHECK(mode IN('read','write'));
ALTER TABLE grants ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE grants ALTER COLUMN source_link_id SET NOT NULL;
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
ALTER TABLE schema_info ADD CONSTRAINT schema_info_version_check CHECK(version=6) NOT VALID;
UPDATE schema_info SET version=6;
ALTER TABLE schema_info VALIDATE CONSTRAINT schema_info_version_check;

ALTER TABLE canvases DROP COLUMN policy_revision;
ALTER TABLE grants DROP COLUMN revoked_at;
ALTER TABLE approvals DROP COLUMN action_digest;
