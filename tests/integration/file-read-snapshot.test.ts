import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AssetStore } from "../../apps/server/dist/adapters/storage/assets.js";
import { agent, board, k, key, start } from "./helpers/runtime-redesign.js";

it("reads snapshots through a data-directory alias while refusing a replaced blob symlink", async () => {
  const a = await agent(),
    workspace = await k.host.workspace(board, a.id),
    path = join(workspace, "published.txt");
  const content = "Published snapshot bytes";
  await writeFile(path, content);
  const snapshot = await k.assets.snapshot(path);
  const alias = join(workspace, "data-alias");
  await symlink(k.assets.directory, alias, "dir");
  const store = new AssetStore(k.db, alias);
  expect(await store.readText(snapshot.assetId, {})).toMatchObject({
    text: content,
    sourceVersion: snapshot.hash,
    state: "eof",
  });
  const blob = join(k.assets.directory, "assets", snapshot.hash, "original");
  await rm(blob);
  await symlink(path, blob);
  await expect(store.readText(snapshot.assetId, {})).rejects.toMatchObject({
    code: "SOURCE_CHANGED",
  });
});

function multipagePdf() {
  const stream = (text: string) =>
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const first = `BT /F1 1 Tf 20 540 Td ${Array.from(
    { length: 220 },
    (_, i) => `0 -2 Td (ROW_${i} ${"evidence ".repeat(5)}) Tj`,
  ).join("\n")} ET`;
  const page = (contents: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 560] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    page(5),
    stream(first),
    page(7),
    stream("BT /F1 12 Tf 20 500 Td (SECOND_PAGE_START) Tj ET"),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = ["0000000000 65535 f \n"];
  objects.forEach((object, i) => {
    offsets.push(`${String(Buffer.byteLength(pdf)).padStart(10, "0")} 00000 n \n`);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  return Buffer.from(
    `${pdf}xref\n0 8\n${offsets.join("")}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

it.each(["path", "node"] as const)(
  "resets the %s PDF text position at the next page",
  async (kind) => {
    const a = await agent(),
      s = await start(a.id),
      path = join(await k.host.workspace(board, a.id), "long-pages.pdf"),
      bytes = multipagePdf();
    await writeFile(path, bytes);
    const asset = await k.assets.put(bytes);
    const node = (
      await k.graph.createNode({
        kind: "pdf",
        title: "Long PDF",
        parentId: board,
        assetId: asset.assetId,
        position: { x: 0, y: 0, width: 220, height: 300 },
        idempotencyKey: key(),
      })
    ).node;
    await k.graph.createLink({ fromId: a.id, toId: node.id, idempotencyKey: key() });
    let page = (
      await s.call("read", {
        ...(kind === "path" ? { path } : { nodeId: node.id }),
        mode: "text",
      })
    ).value;
    const pages = [];
    for (let i = 0; i < 10; i++) {
      expect(page.error).toBeUndefined();
      pages.push(page);
      if (!page.nextCursor) break;
      page = (await s.call("read", { cursor: page.nextCursor })).value;
    }
    expect(pages.filter((p) => p.page === 1).length).toBeGreaterThan(1);
    expect(
      pages
        .filter((p) => p.page === 1)
        .map((p) => p.content ?? p.text)
        .join(""),
    ).toContain("ROW_219");
    expect(pages.at(-1)).toMatchObject({ page: 2, nextCursor: null });
    expect(pages.at(-1).content ?? pages.at(-1).text).toContain("SECOND_PAGE_START");
  },
);
