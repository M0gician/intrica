/** Construct an actual pre-RFC-26 fixture before exercising older migrations. */
export async function removeAddressedSchema(sql) {
  await sql.query(`drop trigger retire_agent_before_delete on nodes;
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
