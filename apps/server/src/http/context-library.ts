import { Type } from "typebox";
import type { AppInstance } from "../app.js";
import type { Kernel } from "../composition.js";
import { readOwnerContextLibrary } from "../modules/work/context-library/service.js";

export function registerContextLibrary(app: AppInstance, k: Kernel) {
  app.get(
    "/api/v2/conversations/:id/context-library",
    {
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }),
        querystring: Type.Object(
          {
            ref: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
            query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6000 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    (req, reply) => {
      reply.header("Cache-Control", "no-store");
      return readOwnerContextLibrary(k.db, req.params.id, req.query);
    },
  );
}
