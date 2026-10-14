import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LocalResource } from "@intrica/contracts";
import { cleanEnvironment, runProcess } from "../host/sandbox.js";
import { DomainError } from "../postgres/database.js";
import type { AssetStore } from "./assets.js";

// The fixed child works relative to an inode-checked cwd. No destination ancestor
// is traversed after that check, and file symlinks are never followed.
const COPY = `
import { open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
const a=JSON.parse(process.argv[1]); let created=false;
const hash=b=>createHash('sha256').update(b).digest('hex');
const reject=(code,message)=>{throw Object.assign(new Error(message),{code})};
const read=async(path,existing=false)=>{
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {const s=await f.stat();if(!s.isFile()||s.size!==a.bytes)reject(existing?'DESTINATION_EXISTS':'TARGET_CHANGED',existing?'目标文件已存在且内容不同；使用其他 fileName':'文件字节长度不匹配');return await f.readFile()} finally {await f.close()}
};
try {
 const cwd=await stat('.'); if(cwd.dev!==a.dev||cwd.ino!==a.ino)reject('TARGET_CHANGED','工作目录已变化');
 const bytes=await read(a.source); if(hash(bytes)!==a.hash)reject('TARGET_CHANGED','发布快照哈希不匹配');
 let output,reused=false;
 try {output=await open(a.name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true}
 catch(e) {if(e.code!=='EEXIST')throw e; const existing=await read(a.name,true);if(hash(existing)!==a.hash)reject('DESTINATION_EXISTS','目标文件已存在且内容不同；使用其他 fileName');reused=true}
 if(output)try {await output.writeFile(bytes);await output.sync()} finally {await output.close()}
 process.stdout.write(JSON.stringify({reused}));
} catch(e) {process.stdout.write(JSON.stringify({error:{code:e.code??'COPY_FAILED',message:e.message},executed:created}));process.exitCode=1}
`;

export async function copySnapshot(
  assets: AssetStore,
  snapshot: NonNullable<LocalResource["snapshot"]>,
  workspace: string,
  fileName: string,
  signal: AbortSignal,
) {
  if (
    !fileName ||
    [".", ".."].includes(fileName) ||
    basename(fileName) !== fileName ||
    fileName.includes("\\") ||
    [...fileName].some((character) => character.charCodeAt(0) < 32)
  )
    throw new DomainError("VALIDATION", "fileName 只能是普通文件名，不接受目录或控制字符", {
      path: "fileName",
      effect: "none",
    });
  const asset = await assets.get(snapshot.assetId);
  if (asset.content_hash !== snapshot.hash || Number(asset.bytes) !== snapshot.bytes)
    throw new DomainError("TARGET_CHANGED", "发布快照元数据不匹配", { effect: "none" });
  const directory = await open(
    workspace,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await directory.stat();
    const response = await runProcess(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        COPY,
        JSON.stringify({
          source: join(assets.directory, "assets", asset.storage_key, "original"),
          name: fileName,
          bytes: snapshot.bytes,
          hash: snapshot.hash,
          dev: info.dev,
          ino: info.ino,
        }),
      ],
      workspace,
      cleanEnvironment(workspace),
      signal,
      30000,
      true,
    );
    const decoded = JSON.parse(response.output);
    if (decoded.error) {
      if (decoded.executed) throw new Error("复制中断；检查目标文件后重试");
      throw new DomainError(decoded.error.code, decoded.error.message, { effect: "none" });
    }
    if (response.exitCode !== 0) throw new Error("复制结果未确认；检查目标文件后重试");
    return {
      path: join(workspace, fileName),
      hash: snapshot.hash,
      bytes: snapshot.bytes,
      reused: decoded.reused,
    };
  } finally {
    await directory.close();
  }
}
