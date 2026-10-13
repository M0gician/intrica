import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { hostCapabilities } from "./capabilities.js";
import { pythonRuntime } from "./runtime-programs.js";
import { buildSandboxCommand, cleanEnvironment, prepareRuntime } from "./sandbox.js";
import { canvasWorkspacePaths } from "./workspace-paths.js";

test("the workspace Python entry runs under OS isolation without xcrun cache writes", async (context) => {
  const python = await pythonRuntime(cleanEnvironment("").PATH!);
  if (!python) return context.skip("Python unavailable");
  const root = await realpath(await mkdtemp(join(tmpdir(), "intrica-python-runtime-")));
  const workspace = join(root, "workspace");
  try {
    await mkdir(join(workspace, ".tmp"), { recursive: true });
    await prepareRuntime(workspace);
    const spec = await buildSandboxCommand(
      "/bin/bash",
      ["-c", 'python3 -c "import sys; print(sys.version_info.major)"'],
      [{ path: workspace, directory: true, write: true }],
      workspace,
      root,
    );
    if (!spec) return context.skip("OS isolation unavailable");
    const out = await promisify(execFile)(spec.command, spec.args, {
      cwd: workspace,
      env: cleanEnvironment(workspace),
      timeout: 15000,
    }).catch((error) => {
      if (
        process.platform === "linux" &&
        /bwrap:[^\n]*(?:namespace|unshare)/i.test(String(error)) &&
        /operation not permitted|permission denied/i.test(String(error))
      ) {
        context.skip("Host disables bubblewrap user namespaces");
        return null;
      }
      throw error;
    });
    if (!out) return;
    expect(out.stdout.trim()).toBe("3");
    expect(out.stderr).not.toContain("xcrun_db");
    const capabilities = await hostCapabilities(workspace);
    expect(capabilities.runtime.python).toBe(python);
    expect(capabilities.runtime.pythonWorkspacePackages).toEqual({ PIL: false });
    expect(capabilities.runtime.pythonInstall).toContain('--target "$PYTHONPATH"');
    if (capabilities.browser.launch && capabilities.isolation) {
      expect(capabilities.browser.launch.args).toContain("--no-sandbox");
      expect(capabilities.browser.launch.requiresOuterIsolation).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canvas navigation names distinct canvas, shared and member directories", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "intrica-workspace-paths-")));
  try {
    await mkdir(join(root, "workspaces/canvas-1/agent-1"), { recursive: true });
    const paths = await canvasWorkspacePaths(root, "canvas-1");
    expect(paths).toEqual({
      canvasRoot: join(root, "workspaces/canvas-1"),
      sharedRoot: join(root, "workspaces/canvas-1/shared"),
      agentRoots: [{ agentId: "agent-1", path: join(root, "workspaces/canvas-1/agent-1") }],
    });
    await expect(canvasWorkspacePaths(root, "../other")).rejects.toMatchObject({
      code: "VALIDATION",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
