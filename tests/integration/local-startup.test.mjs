import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalBackend } from "@intrica/server/runtime";
import { expect, it } from "vitest";

it("a local migration failure closes owned PostgreSQL and retains its data", async () => {
  const profile = await mkdtemp(join(tmpdir(), "intrica-startup-failure-"));
  try {
    await expect(
      startLocalBackend({ userData: profile, schemaFile: join(profile, "missing.sql") }),
    ).rejects.toThrow("ENOENT");
    await expect(readFile(join(profile, "data/postgres/postmaster.pid"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readFile(join(profile, "data/postgres/PG_VERSION"), "utf8")).trim()).toBe("18");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

it("a local start refuses a data directory already owned by another running instance", async () => {
  const profile = await mkdtemp(join(tmpdir(), "intrica-startup-owner-"));
  let backend;
  const previousModel = process.env.MODEL_KIND;
  process.env.MODEL_KIND = "mock";
  try {
    backend = await startLocalBackend({ userData: profile });
    const pid = await readFile(join(profile, "data/postgres/postmaster.pid"), "utf8");
    await expect(startLocalBackend({ userData: profile })).rejects.toThrow("本地数据库仍在使用");
    expect(await readFile(join(profile, "data/postgres/postmaster.pid"), "utf8")).toBe(pid);
    expect((await fetch(`${backend.apiUrl}/api/v2/ready`)).status).toBe(200);
  } finally {
    if (previousModel === undefined) delete process.env.MODEL_KIND;
    else process.env.MODEL_KIND = previousModel;
    await backend?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

it("an incomplete local data directory is preserved for diagnosis", async () => {
  const profile = await mkdtemp(join(tmpdir(), "intrica-startup-data-"));
  const data = join(profile, "data/postgres");
  try {
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "preserve.txt"), "original data");
    await expect(startLocalBackend({ userData: profile })).rejects.toThrow("缺少 PG_VERSION");
    expect(await readFile(join(data, "preserve.txt"), "utf8")).toBe("original data");
    await expect(readFile(join(data, "postmaster.pid"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
