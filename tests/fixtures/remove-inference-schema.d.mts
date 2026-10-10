export function removeInferenceSchema(sql: {
  query: (text: string) => Promise<unknown>;
}): Promise<void>;
