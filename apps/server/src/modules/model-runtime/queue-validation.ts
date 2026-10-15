import { type Database, DomainError } from "../../adapters/postgres/database.js";
import type { RequestIdentity } from "./queue.js";
import type { ResponseValidation } from "./response-validation.js";

export async function recordResponseValidation(
  db: Database,
  request: RequestIdentity,
  owner: string,
  attempt: number,
  receipt: ResponseValidation,
  feedback: string | null,
) {
  return db.transaction(async (tx) => {
    const row = (
      await tx.query(
        `update model_requests set validation_failures=validation_failures+$4,
        validation_feedback=case when $4=1 then $5 else validation_feedback end
        where id=$1 and owner=$2 and lease_until>clock_timestamp() and state in('leased','streaming')
        and ($3::int is null or exists(select 1 from runs where id=model_requests.run_id and epoch=$3 and state='running' and lease_until>clock_timestamp() and cancel_requested_at is null))
        returning validation_failures`,
        [
          request.id,
          owner,
          request.runEpoch ?? null,
          receipt.status === "rejected" ? 1 : 0,
          feedback,
        ],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        "MODEL_LEASE_LOST",
        "Late model validation rejected / 已拒绝迟到的模型校验结果",
      );
    await tx.query(
      `insert into model_response_validations(request_id,attempt,status,issue,stop_reason,output_chars,output_hash,output_excerpt,output_truncated)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        request.id,
        attempt,
        receipt.status,
        receipt.issue,
        receipt.stopReason,
        receipt.outputChars,
        receipt.outputHash,
        receipt.outputExcerpt,
        receipt.outputTruncated,
      ],
    );
    return Number(row.validation_failures);
  });
}
