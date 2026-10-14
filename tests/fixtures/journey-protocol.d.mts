export function toolResults(messages: any[], name: string): Array<{ args: any; value: any }>;
export function taskReplyAddress(messages: any[]): { to: "reply"; id: string };
export function reviewedReply(
  messages: any[],
  options?: { waiting?: boolean; text?: string },
): { text: string } | { tool: string; args: Record<string, any> };
