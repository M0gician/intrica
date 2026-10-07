import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DomainError } from "../postgres/database.js";
import { searchFiles } from "./search.js";

let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "intrica-rg-test-")));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const options = () => ({
  signal: new AbortController().signal,
  authorizePath: vi.fn(async (_path: string) => {}),
  // A bundled binary must work without any rg in PATH or shell startup environment.
  env: { PATH: dirname(process.execPath), LANG: "en_US.UTF-8" },
});

test("bundled rg returns UTF-8 line/byte-column matches and normal no-match results", async () => {
  await writeFile(join(directory, "例子.txt"), "第一行\n前缀 target\nTARGET\n");
  const result = await searchFiles({ path: directory, pattern: "target" }, options());
  expect(result).toMatchObject({
    scannedFiles: 1,
    scannedBytes: Buffer.byteLength("第一行\n前缀 target\nTARGET\n"),
    truncated: false,
    matches: [
      { path: join(directory, "例子.txt"), lineNumber: 2, columnBytes: 8, text: "前缀 target" },
    ],
  });
  expect(
    (await searchFiles({ path: directory, pattern: "target", caseSensitive: false }, options()))
      .matches,
  ).toHaveLength(2);
  expect((await searchFiles({ path: directory, pattern: "absent" }, options())).matches).toEqual(
    [],
  );
});

test("patterns cannot inject flags or a shell and ambient rg config is ignored", async () => {
  await writeFile(join(directory, "-input.txt"), "--files\n$(touch injected)\n[a]\n");
  const configuration = join(directory, ".ripgrep-config");
  await writeFile(configuration, "--glob=*.excluded\n");
  const opts = options();
  const env = { ...opts.env, RIPGREP_CONFIG_PATH: configuration };
  for (const pattern of ["--files", "$(touch injected)", "[a]"]) {
    const result = await searchFiles(
      { path: directory, pattern, fixedStrings: true },
      { ...opts, env },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.text).toBe(pattern);
  }
  await expect(access(join(directory, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("hidden paths are opt-in, explicit hidden files work, and .gitignore is not applied", async () => {
  await writeFile(join(directory, ".hidden"), "needle");
  await writeFile(join(directory, "ignored.txt"), "needle");
  await writeFile(join(directory, ".gitignore"), "ignored.txt\n");
  expect(
    (await searchFiles({ path: directory, pattern: "needle" }, options())).matches,
  ).toHaveLength(1);
  expect(
    (await searchFiles({ path: directory, pattern: "needle", includeHidden: true }, options()))
      .matches,
  ).toHaveLength(2);
  expect(
    (await searchFiles({ path: join(directory, ".hidden"), pattern: "needle" }, options())).matches,
  ).toHaveLength(1);
});

test("symlink files/directories never expand the root and noncanonical roots are rejected", async () => {
  const root = join(directory, "root"),
    outside = join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "needle private");
  await writeFile(join(root, "safe.txt"), "needle allowed");
  await symlink(outside, join(root, "linked-directory"));
  await symlink(join(outside, "secret.txt"), join(root, "linked-file"));
  const result = await searchFiles({ path: root, pattern: "needle" }, options());
  expect(result.matches.map((match) => match.text)).toEqual(["needle allowed"]);
  expect(result.skipped.symlinks).toBe(2);
  await expect(
    searchFiles({ path: join(root, "linked-directory"), pattern: "needle" }, options()),
  ).rejects.toMatchObject({ code: "TARGET_CHANGED" });
});

test("every descendant is subject to read authority; revocation before bytes are read fails closed", async () => {
  const privatePath = join(directory, "private.txt");
  await writeFile(privatePath, "secret needle");
  const opts = options();
  let checks = 0;
  opts.authorizePath.mockImplementation(async (path) => {
    if (path === privatePath && ++checks === 2) throw new DomainError("FORBIDDEN", "grant revoked");
  });
  await expect(searchFiles({ path: directory, pattern: "needle" }, opts)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(checks).toBe(2);
  expect(opts.authorizePath).toHaveBeenCalledWith(directory);
});

test("a directory swapped to an outside symlink during authorization cannot leak matching bytes", async () => {
  const root = join(directory, "root"),
    child = join(root, "child"),
    outside = join(directory, "outside");
  await mkdir(child, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "needle private");
  const opts = options();
  opts.authorizePath.mockImplementation(async (path) => {
    if (path === child) {
      await rename(child, join(root, "old-child"));
      await symlink(outside, child);
    }
  });
  const result = await searchFiles({ path: root, pattern: "needle" }, opts);
  expect(result.matches).toEqual([]);
  expect(result).toMatchObject({ truncated: true, reasons: ["changed_paths"] });
});

test("binary and invalid UTF-8 are skipped while oversized files mark incomplete coverage", async () => {
  await writeFile(join(directory, "binary"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  await writeFile(join(directory, "invalid"), Buffer.from([0xff, 110, 101, 101, 100, 108, 101]));
  await writeFile(join(directory, "large"), "needle".repeat(20));
  await writeFile(join(directory, "text"), "needle");
  const result = await searchFiles(
    { path: directory, pattern: "needle" },
    { ...options(), limits: { maxFileBytes: 50 } },
  );
  expect(result.matches).toHaveLength(1);
  expect(result.skipped).toMatchObject({ binary: 2, oversized: 1 });
  expect(result.reasons).toContain("oversized_files");
});

test("replacing the authorized root during traversal fails closed", async () => {
  const root = join(directory, "root"),
    path = join(root, "file.txt");
  await mkdir(root);
  await writeFile(path, "needle original");
  const opts = options();
  let replaced = false;
  opts.authorizePath.mockImplementation(async (target) => {
    if (target === path && !replaced) {
      replaced = true;
      await rename(root, join(directory, "previous-root"));
      await mkdir(root);
      await writeFile(path, "needle replacement");
    }
  });
  await expect(searchFiles({ path: root, pattern: "needle" }, opts)).rejects.toMatchObject({
    code: "TARGET_CHANGED",
  });
});

test("file, entry, depth and total byte limits explicitly report incomplete scope", async () => {
  await mkdir(join(directory, "sub", "deep"), { recursive: true });
  await writeFile(join(directory, "sub", "deep", "found"), "needle");
  for (let i = 0; i < 3; i++) await writeFile(join(directory, `${i}.txt`), "needle");
  for (const [limits, reason] of [
    [{ maxFiles: 1 }, "max_files"],
    [{ maxEntries: 1 }, "max_entries"],
    [{ maxDepth: 1 }, "max_depth"],
    [{ maxTotalBytes: 1 }, "max_total_bytes"],
  ] as const) {
    const result = await searchFiles(
      { path: directory, pattern: "needle" },
      { ...options(), limits },
    );
    expect(result.truncated).toBe(true);
    expect(result.reasons).toContain(reason);
  }
});

test("files that grow after validation still consume the hard total read budget", async () => {
  for (let i = 0; i < 3; i++) await writeFile(join(directory, `${i}.txt`), "x");
  const opts = options();
  const checks = new Map<string, number>();
  opts.authorizePath.mockImplementation(async (path) => {
    if (!path.endsWith(".txt")) return;
    const count = (checks.get(path) ?? 0) + 1;
    checks.set(path, count);
    if (count === 2) await writeFile(path, "needle".repeat(100));
  });
  const result = await searchFiles(
    { path: directory, pattern: "needle" },
    {
      ...opts,
      limits: { maxFileBytes: 10, maxTotalBytes: 15 },
    },
  );
  expect(result.scannedBytes).toBeLessThanOrEqual(15);
  expect(result.matches).toEqual([]);
  expect(result.reasons).toContain("max_total_bytes");
});

test("result and output limits bound matching lines without claiming complete results", async () => {
  await writeFile(join(directory, "many.txt"), "needle 1234567890\n".repeat(100));
  const limited = await searchFiles(
    { path: directory, pattern: "needle", maxResults: 2 },
    options(),
  );
  expect(limited.matches).toHaveLength(2);
  expect(limited.reasons).toContain("max_results");
  const bytes = await searchFiles(
    { path: directory, pattern: "needle" },
    { ...options(), limits: { maxOutputBytes: 20 } },
  );
  expect(bytes.matches).toEqual([]);
  expect(bytes.reasons).toContain("output_limit");
});

test("missing rg and invalid regex are honest errors, not silent alternative searches", async () => {
  await expect(
    searchFiles(
      { path: directory, pattern: "needle" },
      { ...options(), executable: join(directory, "missing-rg") },
    ),
  ).rejects.toMatchObject({ code: "RG_UNAVAILABLE" });
  await expect(searchFiles({ path: directory, pattern: "[" }, options())).rejects.toMatchObject({
    code: "RG_FAILED",
  });
  await expect(searchFiles({ path: directory, pattern: "\0" }, options())).rejects.toMatchObject({
    code: "VALIDATION",
  });
  await expect(
    searchFiles({ path: directory, pattern: "needle", maxResults: 201 }, options()),
  ).rejects.toMatchObject({ code: "VALIDATION" });
});

test("oversized matching output is explicitly incomplete and never returns unbounded line text", async () => {
  await writeFile(join(directory, "long.txt"), `needle${"x".repeat(20000)}`);
  const result = await searchFiles({ path: directory, pattern: "needle" }, options());
  expect(result).toMatchObject({ matches: [], truncated: true, reasons: ["output_limit"] });
});

test("an already aborted operation does not start rg or read file contents", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already stopped"));
  await expect(
    searchFiles(
      { path: directory, pattern: "needle" },
      { ...options(), signal: controller.signal, executable: join(directory, "missing") },
    ),
  ).rejects.toThrow("already stopped");
});

const hangingExecutable = async () => {
  const executable = join(directory, "hanging-rg"),
    pidPath = join(directory, "pid");
  await writeFile(
    executable,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);\n`,
  );
  await chmod(executable, 0o700);
  await access(executable, constants.X_OK);
  return { executable, pidPath };
};
const assertDead = async (pidPath: string) => {
  const pid = Number(await readFile(pidPath, "utf8"));
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    })
    .toBe(true);
};

const waitUntilReady = async (pidPath: string) => {
  // Cold process startup may exceed Vitest's default one-second poll window while
  // the full suite/build is running. Require a real PID before testing termination.
  await expect
    .poll(
      () =>
        readFile(pidPath, "utf8").then(
          (value) => Number(value) > 0,
          () => false,
        ),
      { timeout: 4000 },
    )
    .toBe(true);
};

test("deadline kills the rg process and reports a timeout rather than complete empty search", async () => {
  const { executable, pidPath } = await hangingExecutable();
  const controller = new AbortController();
  const settled = searchFiles(
    { path: directory, pattern: "needle" },
    { ...options(), executable, signal: controller.signal, limits: { timeoutMs: 5000 } },
  ).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  try {
    await waitUntilReady(pidPath);
    const outcome = await settled;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toMatchObject({ truncated: true, reasons: ["timeout"], scannedFiles: 0 });
    await assertDead(pidPath);
  } finally {
    // Always await child.close, even when readiness or an assertion fails.
    controller.abort(new Error("test cleanup"));
    await settled;
  }
}, 12000);

test("cancellation closes the running rg process and never reports successful search", async () => {
  const { executable, pidPath } = await hangingExecutable();
  const controller = new AbortController();
  const settled = searchFiles(
    { path: directory, pattern: "needle" },
    { ...options(), executable, signal: controller.signal },
  ).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  try {
    await waitUntilReady(pidPath);
    controller.abort(new Error("cancel requested"));
    const outcome = await settled;
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).toMatchObject({ message: "cancel requested" });
    await assertDead(pidPath);
  } finally {
    controller.abort(new Error("test cleanup"));
    await settled;
  }
}, 12000);
