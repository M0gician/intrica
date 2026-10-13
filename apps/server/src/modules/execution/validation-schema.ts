/** Narrow only diagnostic schemas; validation still uses the complete original contract. */
export function diagnosticSchema(schema: any, value: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.anyOf && value && typeof value === "object" && !Array.isArray(value)) {
    const branches = schema.anyOf as any[];
    const keys = [
      ...new Set<string>(
        branches.flatMap((b) =>
          Object.keys(b.properties ?? {}).filter((k) => b.properties[k]?.const !== undefined),
        ),
      ),
    ];
    let remaining = branches;
    for (const key of keys) {
      if (value[key] === undefined) continue;
      const matches = remaining.filter(
        (b) => b.properties?.[key]?.const === undefined || b.properties[key].const === value[key],
      );
      if (matches.length) remaining = matches;
      else if (remaining.every((b) => b.properties?.[key]?.const !== undefined))
        return {
          type: "object",
          properties: { [key]: { enum: remaining.map((b) => b.properties[key].const) } },
          required: [key],
        };
    }
    if (remaining.length === 1) {
      const { anyOf: _union, ...base } = schema;
      const branch = remaining[0];
      return diagnosticSchema(
        {
          ...base,
          ...branch,
          properties: { ...base.properties, ...branch.properties },
          required: [...new Set([...(base.required ?? []), ...(branch.required ?? [])])],
        },
        value,
      );
    }
    const discriminator = keys.find(
      (k) =>
        remaining.every((b) => b.properties?.[k]?.const !== undefined) && value[k] === undefined,
    );
    if (discriminator)
      return {
        type: "object",
        properties: {
          [discriminator]: { enum: remaining.map((b) => b.properties[discriminator].const) },
        },
        required: [discriminator],
      };
    return { ...schema, anyOf: remaining.map((b) => diagnosticSchema(b, value)) };
  }
  if (schema.properties && value && typeof value === "object")
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([key, child]) => [
          key,
          diagnosticSchema(child, value[key]),
        ]),
      ),
    };
  return schema;
}
