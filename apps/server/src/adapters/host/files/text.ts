import { invalid, openSource } from "./identity.js";
export type TextPosition = { byteOffset: number; line: number; column: number; targetLine: number };
/** Bounded scanning and UTF-8 decoding; a continuation never fabricates EOF. */
export async function readText(
  path: string,
  args: { line?: number; offset?: number; position?: TextPosition; sourceVersion?: string },
) {
  const source = await openSource(path, args.sourceVersion);
  const position: TextPosition = {
    ...(args.position ?? {
      byteOffset: 0,
      line: 1,
      column: 0,
      targetLine: args.line ?? args.offset ?? 1,
    }),
  };
  try {
    let scanned = 0;
    const scan = Buffer.alloc(65536);
    while (
      position.line < position.targetLine &&
      scanned < 1048576 &&
      position.byteOffset < source.info.size
    ) {
      const { bytesRead } = await source.handle.read(
        scan,
        0,
        Math.min(scan.length, 1048576 - scanned),
        position.byteOffset,
      );
      if (!bytesRead) break;
      let count = 0;
      while (count < bytesRead && position.line < position.targetLine) {
        if (scan[count++] === 10) position.line++;
      }
      position.byteOffset += count;
      scanned += count;
    }
    if (position.line < position.targetLine) {
      await source.verify();
      const eof = position.byteOffset >= source.info.size;
      return {
        path,
        sourceVersion: source.version,
        state: eof ? "eof" : "positioning",
        text: "",
        offset: position.line,
        nextPosition: eof ? null : position,
      };
    }
    const start = { ...position };
    const buffer = Buffer.alloc(32772);
    const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position.byteOffset);
    let length = Math.min(bytesRead, 32768),
      lines = 0;
    for (let i = 0; i < length; i++)
      if (buffer[i] === 10 && ++lines === 200) {
        length = i + 1;
        break;
      }
    if (length < bytesRead) while (length > 0 && (buffer[length]! & 0xc0) === 0x80) length--;
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) invalid("Binary file; select a media mode / 二进制文件，请使用媒体模式");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      invalid("Source is not valid UTF-8 / 来源不是有效的 UTF-8 文本");
    }
    const pieces = text.split("\n");
    position.byteOffset += length;
    position.line += pieces.length - 1;
    position.column = pieces.length > 1 ? pieces.at(-1)!.length : position.column + text.length;
    await source.verify();
    const eof = position.byteOffset >= source.info.size;
    return {
      path,
      text,
      sourceVersion: source.version,
      state: eof ? "eof" : "reading",
      offset: start.line,
      column: start.column,
      returnedLines: text ? pieces.length - Number(text.endsWith("\n")) : 0,
      truncated: !eof,
      nextPosition: eof ? null : position,
    };
  } finally {
    await source.handle.close();
  }
}
