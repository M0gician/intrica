ALTER TABLE tool_calls ADD COLUMN is_async boolean NOT NULL DEFAULT false;
ALTER TABLE tool_calls ADD COLUMN delivered_at timestamptz;
ALTER TABLE tool_calls ADD COLUMN next_notice_at timestamptz;
ALTER TABLE tool_calls ADD COLUMN notice_count integer NOT NULL DEFAULT 0;
CREATE INDEX tool_calls_pending ON tool_calls(run_id) WHERE is_async AND delivered_at IS NULL;
CREATE INDEX tool_calls_dispatching ON tool_calls(run_id) WHERE state='dispatching';
ALTER TABLE schema_info DROP CONSTRAINT schema_info_version_check;
UPDATE schema_info SET version=3;
-- Repair untouched hires created at the canvas root by the previous hire command.
-- Explicitly moved/reassigned members are left where the owner put them.
WITH repaired AS (
 UPDATE nodes n SET parent_id=a.manager_id,layout_version=n.layout_version+1
 FROM agent_configs a,nodes manager
 WHERE n.id=a.node_id AND a.manager_id=manager.id AND n.parent_id IS NULL
   AND manager.parent_id IS NULL AND n.layout_version=1
   AND EXISTS(SELECT 1 FROM commands c WHERE c.kind='agent.hire' AND c.actor_id=a.manager_id AND c.response->>'id'=n.id)
 RETURNING n.canvas_id
), changed AS (
 UPDATE canvases SET graph_revision=graph_revision+1,event_seq=event_seq+1
 WHERE id IN(SELECT canvas_id FROM repaired) RETURNING id,event_seq
)
INSERT INTO canvas_events(canvas_id,seq,type,payload)
 SELECT id,event_seq,'graph.reset',jsonb_build_object('canvasId',id,'reason','hire_placement_repair') FROM changed;
