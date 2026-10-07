import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it.skipIf(process.platform === "win32")(
  "execution tools inherit login shell exports without placing credentials into the command",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "intrica-env-test-"));
    const shell = join(folder, "shell");
    const before = process.env.SHELL;
    try {
      await writeFile(
        shell,
        '#!/bin/sh\nexport INTRICA_ENV_FIXTURE=from-login\nexec /bin/sh -c "$2"\n',
        { mode: 0o700 },
      );
      process.env.SHELL = shell;
      vi.resetModules();
      const { shellEnvironment } = await import("../../../dist/adapters/model/shell-env.js");
      const environment = await shellEnvironment();
      expect(environment.INTRICA_ENV_FIXTURE).toBe("from-login");
      const { createWorkspaceTools } = await import("../../../dist/adapters/model/tools.js");
      const bash = createWorkspaceTools(folder).find((tool) => tool.name === "bash")!;
      expect(
        JSON.stringify(
          await bash.execute("env", {
            command: 'test "$INTRICA_ENV_FIXTURE" = from-login && printf inherited',
          }),
        ),
      ).toContain("inherited");
    } finally {
      if (before === undefined) delete process.env.SHELL;
      else process.env.SHELL = before;
      vi.resetModules();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
