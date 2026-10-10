// Fixed file operations after host permission checks; input is data, never executable code.
export const FILE_IO_SCRIPT = String.raw`
import { open, mkdir, rename, unlink, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
const {name,path,args,temporary}=JSON.parse(process.argv[1]);
const invalid=message=>{const e=new Error(message);e.code='VALIDATION';throw e};
const read=async()=>{
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const meta=await handle.stat();if(!meta.isFile()||meta.size>1024*1024)invalid('只读取 1MB 以内文本');const buffer=Buffer.alloc(1024*1024+1);let count=0;while(count<buffer.length){const r=await handle.read(buffer,count,buffer.length-count,count);if(!r.bytesRead)break;count+=r.bytesRead}if(count>1024*1024)invalid('文本超过 1MB 读取限制');const bytes=buffer.subarray(0,count);if(bytes.includes(0))invalid('这是二进制文件；支持的图片请使用 read 的 auto/image 模式');try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{invalid('不是有效 UTF-8 文本；支持的图片请使用 read 的 auto/image 模式')}}
  finally{await handle.close()}
};
const write=async content=>{
  await mkdir(dirname(path),{recursive:true});
  const previous=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e});
  if(previous&&!previous.isFile())invalid('写入目标必须是普通文件，不能替换符号链接或目录');
  const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {try {await handle.writeFile(content);if(previous)await handle.chmod(previous.mode&0o777);await handle.sync()}finally{await handle.close()}await rename(temporary,path)}finally{await unlink(temporary).catch(()=>{})}
  return {path,bytes:Buffer.byteLength(content)};
};
try {
  let value;
  if(name==='read'){
    const fullText=await read(),contentHash=createHash('sha256').update(fullText).digest('hex'),lines=fullText.split('\n');
    const offset=args.offset??1,column=args.column??0,page=lines.slice(offset-1,offset-1+(args.limit??200));
    const full=page.map((line,i)=>i?line:line.slice(column)).join('\n')+(offset+page.length<=lines.length?'\n':''),text=full.slice(0,48000),parts=text.split('\n');
    const clipped=text.length<full.length,nextOffset=clipped?offset+parts.length-1:offset+page.length<=lines.length?offset+page.length:null;
    const nextColumn=clipped?(parts.length===1?column+text.length:parts.at(-1).length):0;
    value={path,text,contentHash,capabilities:{text:true,pages:false,frames:false,thumbnail:false,download:true},totalLines:lines.length,offset,column,returnedLines:page.length?parts.length:0,truncated:nextOffset!==null,nextOffset,nextColumn};
  }else if(name==='write')value=await write(args.content);
  else if(name==='edit'){
    const text=await read();
    const edits=args.edits.map(({oldText,newText})=>{
      const start=text.indexOf(oldText);
      if(!oldText||start<0||text.indexOf(oldText,start+1)!==-1)invalid('每项原文必须精确且唯一匹配同一份原始内容');
      return {start,end:start+oldText.length,newText};
    }).sort((a,b)=>a.start-b.start);
    let end=0,content='';
    for(const edit of edits){if(edit.start<end)invalid('修改范围不能重叠');content+=text.slice(end,edit.start)+edit.newText;end=edit.end}
    value=await write(content+text.slice(end));
  }else if(name==='list_directory'){
    const entries=(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    const offset=args.offset??0,limit=args.limit??50;
    value={path,total:entries.length,nextOffset:offset+limit<entries.length?offset+limit:null,entries:entries.slice(offset,offset+limit).map(e=>({name:e.name,type:e.isDirectory()?'directory':e.isSymbolicLink()?'symlink':'file'}))};
  }else invalid('未知文件操作');
  process.stdout.write(JSON.stringify({value}));
}catch(e){process.stdout.write(JSON.stringify({error:{code:e.code??'IO_ERROR',message:e.message}}));process.exitCode=1}
`;
