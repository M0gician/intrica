import { Type } from "typebox";

export const pathParameter = Type.String({ minLength: 1, maxLength: 4096 });
export const fileParameters = {
  read: Type.Object(
    {
      path: pathParameter,
      mode: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("text"), Type.Literal("image")]),
      ),
      frame: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      column: Type.Optional(Type.Integer({ minimum: 0, maximum: 1048576 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    },
    { additionalProperties: false },
  ),
  write: Type.Object(
    { path: pathParameter, content: Type.String({ maxLength: 1000000 }) },
    { additionalProperties: false },
  ),
  edit: Type.Object(
    {
      path: pathParameter,
      edits: Type.Array(
        Type.Object(
          {
            oldText: Type.String({ minLength: 1, maxLength: 100000 }),
            newText: Type.String({ maxLength: 100000 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 64 },
      ),
    },
    { additionalProperties: false },
  ),
  bash: Type.Object(
    {
      command: Type.String({ minLength: 1, maxLength: 8000 }),
      cwd: Type.Optional(pathParameter),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
      fullHost: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
};
