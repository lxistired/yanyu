// Bounded raster-only PDF pages. Poppler never invokes PDF actions or a browser viewer.
import {execFile} from 'node:child_process';
import {mkdirSync,lstatSync,readdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const READER_LIMITS=Object.freeze({version:'poppler-png-v1',scales:[75,100,150],maxSide:1800,imageBytes:16*1024*1024,cacheBytes:64*1024*1024,timeoutMs:6000});
const sha=b=>createHash('sha256').update(b).digest('hex');
function fail(status,message){throw Object.assign(Error(message),{status})}
export function validatePage(value,pages){if(!Number.isSafeInteger(value)||value<1||value>pages)fail(400,'Page is outside the document');return value}
export function validateScale(value){if(!READER_LIMITS.scales.includes(value))fail(400,'Scale must be 75, 100 or 150');return value}
export function validatePng(bytes,side){if(bytes.length>READER_LIMITS.imageBytes||bytes.length<45||bytes.subarray(-12).toString('hex')!=='0000000049454e44ae426082'||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.subarray(12,16).toString()!=='IHDR')fail(422,'Invalid rendered image');const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);if(!w||!h||w>side||h>side)fail(422,'Rendered image exceeds dimensions');return bytes}
// Internal testable subprocess boundary; HTTP callers cannot select executable or arguments.
export function boundedRasterProcess(binary,args,bytes){return new Promise((resolve,reject)=>{const child=execFile('/usr/bin/prlimit',['--as=536870912','--cpu=4','--fsize=16777216','--nofile=64','--core=0','--',binary,...args],{encoding:'buffer',timeout:READER_LIMITS.timeoutMs,maxBuffer:READER_LIMITS.imageBytes,killSignal:'SIGKILL',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}},(error,out,stderr)=>{if(error||stderr.toString('utf8').split('\n').some(line=>line&&line!=='Fontconfig error: No writable cache directories'))return reject(Object.assign(Error('PDF page rendering failed or exceeded limits; text preview remains available'),{status:422}));resolve(out)});child.stdin.on('error',()=>{});child.stdin.end(bytes)})}
export async function renderPdfPage(bytes,page,scale){validatePage(page,40);validateScale(scale);const side=scale*12;const out=await boundedRasterProcess('/usr/bin/pdftoppm',['-f',String(page),'-l',String(page),'-singlefile','-scale-to',String(side-1),'-png','-'],bytes);return validatePng(out,side)}

export function pdfPageReader(storage,db){
 const cache=join(storage,'pdf-page-cache');mkdirSync(cache,{recursive:true,mode:0o700});if(!lstatSync(cache).isDirectory()||lstatSync(cache).isSymbolicLink())fail(503,'Unsafe PDF cache');
 db.exec('CREATE TABLE IF NOT EXISTS document_reader_state(document_id TEXT PRIMARY KEY REFERENCES research_documents(id), sha256 TEXT NOT NULL, page INTEGER NOT NULL, bookmark INTEGER, scale INTEGER NOT NULL)');
 let busy=false;let busyId=null;
 const files=()=>readdirSync(cache).filter(n=>/^[a-f0-9-]{36}-[a-f0-9]{64}-poppler-png-v1-p\d{1,2}-s(75|100|150)\.png$/.test(n)).map(n=>({n,s:lstatSync(join(cache,n))}));
 function trim(incoming=0){let list=files();if(list.some(x=>!x.s.isFile()||x.s.isSymbolicLink()))fail(503,'Unsafe PDF cache entry');let total=list.reduce((a,x)=>a+x.s.size,0);for(const item of list.sort((a,b)=>a.s.mtimeMs-b.s.mtimeMs)){if(total+incoming<=READER_LIMITS.cacheBytes)break;unlinkSync(join(cache,item.n));total-=item.s.size}}
 for(const n of readdirSync(cache))if(/^[a-f0-9-]{36}-[a-f0-9]{64}-poppler-png-v1-p\d{1,2}-s(75|100|150)\.png\.tmp$/.test(n)){const st=lstatSync(join(cache,n));if(!st.isFile()||st.isSymbolicLink())fail(503,'Unsafe temporary cache');unlinkSync(join(cache,n))}
 trim();
 function original(r){const bytes=Buffer.from(r.original);if(bytes.length!==r.bytes||sha(bytes)!==r.sha256)fail(409,'Original byte integrity check failed');return bytes}
 function state(r){const saved=db.prepare('SELECT * FROM document_reader_state WHERE document_id=? AND sha256=?').get(r.id,r.sha256);return {page:saved?validatePage(saved.page,r.pages):1,bookmark:saved?.bookmark==null?null:validatePage(saved.bookmark,r.pages),scale:saved?validateScale(saved.scale):100,pages:r.pages,sha256:r.sha256}}
 return {isBusy:id=>busyId===id,state,setState(r,data){if(!data||Array.isArray(data)||Object.keys(data).sort().join(',')!=='bookmark,page,scale')fail(400,'page, bookmark and scale required');validatePage(data.page,r.pages);validateScale(data.scale);if(data.bookmark!==null)validatePage(data.bookmark,r.pages);db.prepare('INSERT INTO document_reader_state VALUES(?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET sha256=excluded.sha256,page=excluded.page,bookmark=excluded.bookmark,scale=excluded.scale').run(r.id,r.sha256,data.page,data.bookmark,data.scale);return state(r)},async image(r,page,scale){validatePage(page,r.pages);validateScale(scale);const bytes=original(r);const path=join(cache,`${r.id}-${r.sha256}-${READER_LIMITS.version}-p${page}-s${scale}.png`);
 try{const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=lstatSync(path);if(!st.isFile()||st.size>READER_LIMITS.imageBytes)fail(503,'Unsafe cache image');try{return validatePng(readFileSync(fd),scale*12)}catch(e){if(e.status!==422)throw e;unlinkSync(path)}}finally{closeSync(fd)}}catch(e){if(e.code!=='ENOENT')throw e}
 if(busy)fail(429,'One PDF page render at a time; retry shortly');busy=true;busyId=r.id;try{const image=await renderPdfPage(bytes,page,scale);trim(image.length);try{writeFileSync(path+'.tmp',image,{flag:'wx',mode:0o600});renameSync(path+'.tmp',path)}finally{try{unlinkSync(path+'.tmp')}catch(e){if(e.code!=='ENOENT')throw e}}return image}finally{busy=false;busyId=null}
 }};
}
