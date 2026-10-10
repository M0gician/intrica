/** Remove schema 16 additions when constructing a pre-inference migration fixture. */
export async function removeInferenceSchema(sql) {
  await sql.query(`alter table tool_calls drop column inference_item_id,drop column primary_response;
    alter table model_calls drop column inference_attempt_id;
    alter table messages drop column cutover_request_id;
    drop table inference_items,inference_attempts,inference_requests,context_entries;
    alter table conversations drop column context_seq;`);
}
