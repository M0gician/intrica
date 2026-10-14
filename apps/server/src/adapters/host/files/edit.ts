import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fileVersion, invalid, openSource } from "./identity.js";
export async function writeText(
  path: string,
  temporary: string,
  content: string,
  expected?: string,
) {
  await mkdir(dirname(path), { recursive: true });
  const previous = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous && !previous.isFile())
    invalid("Write requires a regular file / 写入目标必须是普通文件");
  if (expected && (!previous || fileVersion(previous) !== expected))
    invalid("Edit source changed / 编辑来源已变化", "SOURCE_CHANGED");
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(content);
      if (previous) await handle.chmod(previous.mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expected && fileVersion(await lstat(path)) !== expected)
      invalid("Edit source changed / 编辑来源已变化", "SOURCE_CHANGED");
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { path, bytes: Buffer.byteLength(content), effect: "committed" };
}
export async function editText(
  path: string,
  temporary: string,
  edits: Array<{ oldText: string; newText: string }>,
) {
  const source = await openSource(path);
  let original: string;
  try {
    if (source.info.size > 16 * 1024 * 1024)
      invalid("Atomic edit supports files up to 16 MiB / 原子编辑支持 16 MiB 以内文件");
    const buffer = Buffer.alloc(source.info.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const r = await source.handle.read(buffer, count, buffer.length - count, count);
      if (!r.bytesRead) break;
      count += r.bytesRead;
    }
    if (count !== source.info.size)
      invalid("Edit source changed / 编辑来源已变化", "SOURCE_CHANGED");
    try {
      original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, count),
      );
    } catch {
      invalid("Edit requires UTF-8 text / 编辑需要 UTF-8 文本");
    }
    await source.verify();
  } finally {
    await source.handle.close();
  }
  const matches = edits
    .map(({ oldText, newText }) => {
      const start = original.indexOf(oldText);
      if (!oldText || start < 0 || original.indexOf(oldText, start + 1) !== -1)
        invalid("Each oldText must match exactly once / 每个 oldText 必须精确且唯一匹配");
      return { start, end: start + oldText.length, newText };
    })
    .sort((a, b) => a.start - b.start);
  let end = 0,
    content = "";
  for (const edit of matches) {
    if (edit.start < end) invalid("Edits cannot overlap / 编辑范围不能重叠");
    content += original.slice(end, edit.start) + edit.newText;
    end = edit.end;
  }
  return writeText(path, temporary, content + original.slice(end), source.version);
}
