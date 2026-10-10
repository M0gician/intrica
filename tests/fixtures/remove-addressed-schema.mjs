import { removeInferenceSchema } from "./remove-inference-schema.mjs";

/** Construct an actual pre-RFC-26 fixture before exercising older migrations. */
export async function removeAddressedSchema(sql) {
  await removeInferenceSchema(sql);
  await sql.query(`drop table execution_environments;
    drop table message_followups;
    drop table message_waits;
    drop table request_dependencies;
    alter table conversations drop column last_agent_expedite_at;
    alter table tool_calls drop column observation_id,drop column model_call_id,drop column retry_of;
    drop index tool_calls_repairs;
    alter table tool_calls drop column audit;
    alter table tool_calls drop constraint tool_calls_effect_class_check;
    alter table tool_calls add constraint tool_calls_effect_class_check check(effect_class in ('read','graph','external'));
    drop table model_tool_observations;
    drop table diagnostic_settings;
    alter table model_calls drop column manifest,drop column diagnostics,drop column diagnostics_expires_at,drop column manifest_expires_at;
    drop trigger retire_agent_before_delete on nodes;
    drop function retire_agent_conversation();
    alter table approvals drop column origin_dispatch_id;
    drop table message_dispatches;
    drop table message_requests;
    drop index messages_dispatch;
    drop index messages_request;
    alter table conversations drop column identity_kind,drop column generation;
    alter table tool_calls drop column work_item_id,drop column generation;
    alter table model_calls drop column generation_id,drop column work_item_id;
    update messages set content=content-'workItemId'-'collaborationRequestId';
    update conversations set context=context-'workItemId'-'outputGeneration'-'pendingOutput'-'messageRepairAttempts'-'messageProtocolBlocked';
    update runs set frozen_input=frozen_input-'workItemId'-'generation';`);
}
