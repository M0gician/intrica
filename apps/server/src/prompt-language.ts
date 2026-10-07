/** Request language is explicit; a remote host's locale must not choose the user's prompts. */
export type PromptLanguage = "en" | "zh-CN";
export function promptLanguage(locale?: string): PromptLanguage {
  return /^zh(?:-|$)/i.test(locale?.split(/[;,]/, 1)[0]?.trim() ?? "") ? "zh-CN" : "en";
}
export const promptText = (language: PromptLanguage | undefined, en: string, zh: string) =>
  language === "zh-CN" ? zh : en;
