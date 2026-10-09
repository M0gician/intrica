import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../../dist/adapters/model/tools.js";

describe("PI workspace tools", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "intrica-pi-tools-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("executes the built-in write, read, edit and bash tools against the workspace", async () => {
    const tools = createWorkspaceTools(cwd);
    expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "rg"]);
    const run = (name: string, args: unknown) =>
      tools.find((tool) => tool.name === name)!.execute(name, args);
    await run("write", { path: "note.md", content: "# 线索\n旧内容\n" });
    expect(JSON.stringify(await run("read", { path: "note.md" }))).toContain("旧内容");
    await run("edit", { path: "note.md", edits: [{ oldText: "旧内容", newText: "新内容" }] });
    expect(await readFile(join(cwd, "note.md"), "utf8")).toBe("# 线索\n新内容\n");
    const updates: unknown[] = [];
    const result = await tools
      .find((tool) => tool.name === "bash")!
      .execute("bash", { command: "cat note.md" }, undefined, (part) => updates.push(part));
    expect(JSON.stringify(result)).toContain("新内容");
    expect(JSON.stringify(updates)).toContain("新内容");
  });

  it("uses the same bounded text pagination and binary rejection as Agent read", async () => {
    const read = createWorkspaceTools(cwd).find((tool) => tool.name === "read")!;
    await writeFile(join(cwd, "long.txt"), `${"a".repeat(50000)}\nsecond line\n`);
    const first = await read.execute("first", { path: "long.txt", mode: "text" });
    const page = JSON.parse(first.content.find((part) => part.type === "text")!.text);
    expect(page).toMatchObject({
      offset: 1,
      column: 0,
      nextOffset: 1,
      nextColumn: 48000,
      truncated: true,
    });
    expect(page.text).toHaveLength(48000);
    const next = await read.execute("next", {
      path: "long.txt",
      offset: page.nextOffset,
      column: page.nextColumn,
    });
    const continued = JSON.parse(next.content.find((part) => part.type === "text")!.text);
    expect(continued.text).toBe(`${"a".repeat(2000)}\nsecond line\n`);
    expect(continued.truncated).toBe(false);
    await writeFile(join(cwd, "binary.bin"), Buffer.from([0xff, 0, 1, 2]));
    await expect(
      read.execute("binary", { path: "binary.bin", mode: "text" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      read.execute("frame", { path: "long.txt", mode: "text", frame: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("auto-detects image content regardless of extension, applies vision gating and rejects text mode", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    await writeFile(join(cwd, "picture.dat"), png);
    const read = createWorkspaceTools(cwd, undefined, { supportsVision: true }).find(
      (tool) => tool.name === "read",
    )!;
    const image = await read.execute("image", { path: "picture.dat" });
    expect(
      image.content.some((part) => part.type === "image" && part.mimeType === "image/png"),
    ).toBe(true);
    expect(image.details).toMatchObject({ mediaType: "image", frames: 1, frame: 0, width: 2 });
    await expect(
      read.execute("text-image", { path: "picture.dat", mode: "text" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      read.execute("bad-frame", { path: "picture.dat", frame: 1 }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      read.execute("paging-image", { path: "picture.dat", offset: 1 }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const textOnly = createWorkspaceTools(cwd, undefined, { supportsVision: false }).find(
      (tool) => tool.name === "read",
    )!;
    await expect(textOnly.execute("text-only", { path: "picture.dat" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("does not infer images from extensions or claim non-image media support", async () => {
    const read = createWorkspaceTools(cwd, undefined, { supportsVision: true }).find(
      (tool) => tool.name === "read",
    )!;
    await writeFile(join(cwd, "text.png"), "ordinary UTF-8 text");
    const text = await read.execute("text", { path: "text.png" });
    expect(text.content.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(text)).toContain("ordinary UTF-8 text");
    await expect(
      read.execute("forced-image", { path: "text.png", mode: "image" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await writeFile(join(cwd, "document.pdf"), "%PDF-1.7\nASCII is not extracted document text");
    await expect(read.execute("pdf", { path: "document.pdf" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("PDF"),
    });
  });

  it("searches owner workspace paths with bundled rg, bounded results and no symlink traversal", async () => {
    const outside = join(cwd, "outside"),
      root = join(cwd, "root");
    await mkdir(outside);
    await mkdir(root);
    await writeFile(join(outside, "secret.txt"), "needle outside");
    await writeFile(join(root, "note.txt"), "needle one\nneedle two\n");
    await symlink(outside, join(root, "linked"));
    const rg = createWorkspaceTools(cwd, { PATH: "/nonexistent", LANG: "en_US.UTF-8" }).find(
      (tool) => tool.name === "rg",
    )!;
    const found = await rg.execute("search", { path: "root", pattern: "needle", maxResults: 1 });
    const parsed = JSON.parse(found.content.find((part) => part.type === "text")!.text);
    expect(parsed.path).toBe(await realpath(root));
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0].text).not.toContain("outside");
    expect(parsed).toMatchObject({ truncated: true, reasons: ["max_results"] });
    const complete = await rg.execute("all", { path: "root", pattern: "needle" });
    const all = JSON.parse(complete.content.find((part) => part.type === "text")!.text);
    expect(all.matches).toHaveLength(2);
    expect(all.skipped.symlinks).toBe(1);
  });

  it("honors an explicit trusted rg override and pre-aborted owner read/search operations", async () => {
    const tools = createWorkspaceTools(cwd, { INTRICA_RG_PATH: join(cwd, "missing-rg") });
    const rg = tools.find((tool) => tool.name === "rg")!;
    await expect(rg.execute("missing", { path: ".", pattern: "needle" })).rejects.toMatchObject({
      code: "RG_UNAVAILABLE",
    });
    const configured = createWorkspaceTools(
      cwd,
      {},
      { rgExecutable: join(cwd, "missing-configured-rg") },
    ).find((tool) => tool.name === "rg")!;
    await expect(
      configured.execute("configured", { path: ".", pattern: "needle" }),
    ).rejects.toMatchObject({ code: "RG_UNAVAILABLE" });
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      rg.execute("cancel", { path: ".", pattern: "needle" }, controller.signal),
    ).rejects.toThrow("already cancelled");
    await expect(
      tools
        .find((tool) => tool.name === "read")!
        .execute("cancel", { path: "missing" }, controller.signal),
    ).rejects.toThrow("already cancelled");
  });

  it("aborts a running command and prevents later side effects", async () => {
    const controller = new AbortController();
    const tool = createWorkspaceTools(cwd).find((tool) => tool.name === "bash")!;
    const result = tool.execute(
      "cancel",
      { command: "printf ready; sleep 1; touch should-not-exist" },
      controller.signal,
      (part) => {
        if (JSON.stringify(part).includes("ready")) controller.abort();
      },
    );
    await expect(result).rejects.toMatchObject({
      outcome: { termination: "cancelled", taskStatus: "unverified", output: "ready" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(readFile(join(cwd, "should-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
