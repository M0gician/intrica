export function removeAddressedSchema(sql: {
  query: (text: string) => Promise<unknown>;
}): Promise<void>;
