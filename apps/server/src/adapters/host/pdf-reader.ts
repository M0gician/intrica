import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { result, type ToolResult } from "../../modules/execution/tool-calls.js";
import { DomainError } from "../postgres/database.js";

export type PdfOptions = {
  page?: number;
  offset?: number;
  column?: number;
  limit?: number;
  render?: boolean;
  characterOffset?: number;
  characterLimit?: number;
};
export type PdfPage = {
  mediaType: "pdf";
  page: number;
  pageCount: number;
  nextPage: number | null;
  width: number;
  height: number;
  text: string;
  hasText: boolean;
  offset: number;
  nextOffset: number | null;
  nextColumn: number;
  totalLines: number;
  totalChars: number;
  nextCharOffset: number | null;
  image?: string;
  note: string;
};
const require = createRequire(import.meta.url);
let active = 0;
// The parser sees only approved bytes, never the source path. Process isolation
// contains cancellation, parser CPU and JS heap; it is not an OS security sandbox.
const SCRIPT = String.raw`
console.log=(...v)=>console.error(...v);
const chunks=[];let bytes=0;for await(const c of process.stdin){bytes+=c.length;if(bytes>30*1024*1024)throw Error('PDF input too large');chunks.push(c)}
const {data,options}=JSON.parse(Buffer.concat(chunks).toString());
const {getDocument}=await import(process.argv[1]);
let task;
try{
 task=getDocument({data:new Uint8Array(Buffer.from(data,'base64')),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,stopAtErrors:true,maxImageSize:16000000,cMapUrl:process.argv[2],cMapPacked:true,standardFontDataUrl:process.argv[3],wasmUrl:process.argv[4],verbosity:0});
 const doc=await task.promise;
 if(doc.numPages>2000)throw Error('PDF exceeds 2000 pages');
 const pageNumber=options.page??1;if(!Number.isInteger(pageNumber)||pageNumber<1||pageNumber>doc.numPages)throw Error('PDF page out of range: '+doc.numPages);
 const page=await doc.getPage(pageNumber),viewport=page.getViewport({scale:1});
 const content=await page.getTextContent();
 const raw=content.items.map(p=>'str'in p?p.str+(p.hasEOL?'\n':' '):'').join('');
 const lines=raw.split('\n'),offset=options.offset??1,column=options.column??0,selected=lines.slice(offset-1,offset-1+(options.limit??200));
 const full=selected.map((s,i)=>i?s:s.slice(column)).join('\n')+(offset+selected.length<=lines.length?'\n':'');let text=full.slice(0,48000);const parts=text.split('\n');
 const clipped=text.length<full.length,nextOffset=clipped?offset+parts.length-1:offset+selected.length<=lines.length?offset+selected.length:null;
 const charStart=options.characterOffset??0,charEnd=Math.min(raw.length,charStart+(options.characterLimit??6000));if(options.characterOffset!==undefined)text=raw.slice(charStart,charEnd);
 const value={mediaType:'pdf',page:pageNumber,pageCount:doc.numPages,nextPage:pageNumber<doc.numPages?pageNumber+1:null,width:viewport.width,height:viewport.height,text,hasText:raw.trim().length>0,offset,totalLines:lines.length,totalChars:raw.length,nextCharOffset:options.characterOffset!==undefined&&charEnd<raw.length?charEnd:null,nextOffset,nextColumn:clipped?(parts.length===1?column+text.length:parts.at(-1).length):0,note:'Text extraction may omit reading order or image-only content; no OCR. Review page images for layout and visual evidence.'};
 if(options.render){
  // pdfjs 6.3.289 can resolve render/getOperatorList before propagating a
  // rejected operator stream. Capture its real error before that race so an
  // oversized embedded image cannot be reported as a successful blank page.
  // Remove this pinned-internals workaround only when an upgraded pdfjs passes
  // the oversized-image rejection regression without it.
  const handler=page._transport?.messageHandler;
  if(typeof handler?.sendWithStream!=='function')throw Error('PDF parser stream contract changed');
  const sendWithStream=handler.sendWithStream;let operatorError;
  handler.sendWithStream=function(...args){
   const stream=sendWithStream.apply(this,args);if(args[0]!=='GetOperatorList')return stream;
   const reader=stream.getReader();return new ReadableStream({
    async pull(controller){try{const part=await reader.read();if(part.done)controller.close();else controller.enqueue(part.value)}catch(e){operatorError??=e;controller.error(e)}},
    cancel(reason){return reader.cancel(reason)}
   });
  };
  const {createCanvas}=await import(process.argv[5]);
  const view=page.getViewport({scale:Math.min(2,1600/Math.max(viewport.width,viewport.height))});
  if(!Number.isFinite(view.width)||!Number.isFinite(view.height)||view.width<=0||view.height<=0)throw Error('Invalid PDF page size');
  const canvas=createCanvas(Math.max(1,Math.ceil(view.width)),Math.max(1,Math.ceil(view.height)));
  await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport:view}).promise;
  if(operatorError)throw operatorError;
  const png=await canvas.encode('png');if(png.length>8*1024*1024)throw Error('PDF preview exceeds 8MiB');value.image=png.toString('base64');
 }
 process.stdout.write(JSON.stringify({value}));
}catch(e){process.stdout.write(JSON.stringify({error:e?.name==='PasswordException'?'PDF is encrypted; unlock it before importing or reading':String(e?.message??e).slice(0,500)}));process.exitCode=1}
finally{await task?.destroy()}
`;

export async function readPdf(
  data: Buffer,
  options: PdfOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<PdfPage> {
  signal.throwIfAborted();
  if (data.length > 20 * 1024 * 1024 || data.subarray(0, 5).toString() !== "%PDF-")
    throw new DomainError("VALIDATION", "PDF 必须为 20MiB 以内有效文档");
  if (active >= 2) throw new DomainError("LIMIT_REACHED", "PDF 处理繁忙，请稍后重试");
  active++;
  try {
    const entry = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const packageDir = dirname(dirname(dirname(entry)));
    return await new Promise<PdfPage>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=256",
          "--input-type=module",
          "-e",
          SCRIPT,
          pathToFileURL(entry).href,
          `${join(packageDir, "cmaps")}/`,
          `${join(packageDir, "standard_fonts")}/`,
          `${join(packageDir, "wasm")}/`,
          pathToFileURL(require.resolve("@napi-rs/canvas")).href,
        ],
        {
          env: { PATH: dirname(process.execPath), ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "",
        failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = () => stop(signal.reason ?? new Error("PDF 已取消"));
      const timer = setTimeout(
        () => stop(new DomainError("VALIDATION", "PDF 处理超过 15 秒限制")),
        15000,
      );
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 12 * 1024 * 1024)
          stop(new DomainError("VALIDATION", "PDF 返回内容超过限制"));
      });
      child.stderr.resume();
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stop(error);
      });
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code) => {
        cleanup();
        if (failure) return reject(failure);
        try {
          const decoded = JSON.parse(output);
          if (code !== 0 || decoded.error || !decoded.value)
            throw new Error(decoded.error ?? "PDF parser exited");
          resolve(decoded.value);
        } catch (error) {
          reject(
            new DomainError(
              "VALIDATION",
              `无法读取 PDF：${(error as Error).message.slice(0, 500)}`,
            ),
          );
        }
      });
      child.stdin.end(JSON.stringify({ data: data.toString("base64"), options }));
      if (signal.aborted) abort();
    });
  } finally {
    active--;
  }
}

export function pdfToolResult(page: PdfPage, source: Record<string, unknown>): ToolResult {
  const { image, ...metadata } = page;
  return {
    details: metadata,
    content: [
      ...result({ ...source, ...metadata }).content,
      ...(image ? [{ type: "image" as const, mimeType: "image/png", data: image }] : []),
    ],
  };
}
