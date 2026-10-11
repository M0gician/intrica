/** A deterministic model fixture that authors the current explicit-message protocol. */
export function addressedOutput(system, text, kind = "result") {
  const id = system.match(/Current work item: (request-[\w-]+)/)?.[1];
  return JSON.stringify(
    id ? { to: "request", id, kind, message: text } : { to: "internal", message: text },
  );
}
export function wireOutput(messages, text) {
  return addressedOutput(
    messages
      .filter((m) => ["system", "developer"].includes(m.role))
      .map((m) => m.content)
      .join("\n"),
    text,
  );
}
