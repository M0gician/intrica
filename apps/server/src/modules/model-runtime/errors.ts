export type ModelFailure = { code: string; retryable: boolean; shared: boolean; message: string };

/** Provider prose is classification input only. Never put it in user-facing diagnostics. */
export function classifyModelFailure(raw: string, status?: number): ModelFailure {
  const error = (code: string, retryable: boolean, shared: boolean, message: string) => ({
    code,
    retryable,
    shared,
    message,
  });
  if (/CONTEXT_SUMMARY_INVALID/.test(raw))
    return error(
      "CONTEXT_SUMMARY_INVALID",
      false,
      false,
      "Summary rejected; original checkpoint preserved / 摘要无效，原 checkpoint 已保留",
    );
  if (
    /developer.{0,40}(unsupported|not.supported|not.allowed)|unsupported.{0,40}developer/i.test(raw)
  )
    return error(
      "MODEL_ROLE_UNSUPPORTED",
      false,
      false,
      "Endpoint does not support the developer role; check the model protocol / 端点不支持 developer 角色，请检查模型协议",
    );
  if (
    /insufficient_quota|insufficient.balance|balance.{0,20}(exhaust|insufficient)|credit.{0,20}exhaust|余额不足/i.test(
      raw,
    )
  )
    return error(
      "MODEL_BALANCE",
      false,
      false,
      "Model balance exhausted; update billing / 模型余额耗尽，请处理计费配置",
    );
  if (
    status === 401 ||
    status === 403 ||
    /authentication|invalid.api.key|unauthorized|\b401\b|\b403\b/i.test(raw)
  )
    return error(
      "MODEL_AUTH",
      false,
      false,
      "Model authentication failed; check endpoint credentials / 模型认证失败，请检查端点凭据",
    );
  if (/concurren|simultaneous|并发/i.test(raw))
    return error("MODEL_CAPACITY", true, true, "Model capacity is full / 模型并发容量已满");
  if (/engine_overloaded|overload|\b503\b/i.test(raw) || status === 503)
    return error("MODEL_OVERLOADED", true, true, "Model service is busy / 模型服务繁忙");
  if (status === 429 || /\b429\b|rate.limit|too.many.requests/i.test(raw))
    return error("MODEL_RATE_LIMIT", true, true, "Model rate limit reached / 模型请求限流");
  if (/timeout|timed.out|etimedout|\b408\b|\b504\b/i.test(raw) || status === 408 || status === 504)
    return error("MODEL_TIMEOUT", true, false, "Model request timed out / 模型请求超时");
  if (
    /network|fetch failed|econnreset|econnrefused|enotfound|socket|\b502\b/i.test(raw) ||
    status === 502
  )
    return error("MODEL_NETWORK", true, false, "Model connection interrupted / 模型连接中断");
  return error(
    "MODEL_CONFIGURATION",
    false,
    false,
    "Model request rejected; check endpoint and model configuration / 模型请求被拒绝，请检查端点及模型配置",
  );
}

export function retryDelay(
  attempt: number,
  retryAfter?: string,
  now = Date.now(),
  random = Math.random,
) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const deadline =
      Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(deadline) && deadline >= now) return Math.max(1000, deadline - now);
  }
  return (
    Math.min(60000, 1000 * 2 ** Math.min(10, Math.max(0, attempt - 1))) * (0.75 + random() * 0.25)
  );
}
