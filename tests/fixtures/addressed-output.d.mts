export function addressedOutput(system: string, text: string, kind?: "result" | "update"): string;
export function wireOutput(
  messages: Array<{ role: string; content: unknown }>,
  text: string,
): string;
