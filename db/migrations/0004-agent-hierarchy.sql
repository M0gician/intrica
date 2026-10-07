-- Management is derived from the immediate spatial parent; grants stay explicit.
ALTER TABLE agent_configs DROP COLUMN manager_id;
ALTER TABLE schema_info DROP CONSTRAINT IF EXISTS schema_info_version_check;
UPDATE schema_info SET version=4;
UPDATE canvases SET policy_revision=policy_revision+1,graph_revision=graph_revision+1,event_seq=event_seq+1;
INSERT INTO canvas_events(canvas_id,seq,type,payload)
 SELECT id,event_seq,'graph.reset',jsonb_build_object('reason','agent_hierarchy') FROM canvases;
