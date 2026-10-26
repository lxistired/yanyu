import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {researchDocuments,extractDocument,DOCUMENT_LIMITS as L} from '../backend/research-documents.mjs';
const directory=await mkdtemp(join(tmpdir(),'document-audit-'));
let service;const results=[];const spaces=new Map([['w1',{data:{name:'Workspace'}}],['w2',{data:{name:'Other'}}]]);
const workspace={get:(kind,id)=>{if(!spaces.has(id))throw Object.assign(Error('missing'),{code:'NOT_FOUND'});return spaces.get(id)},list:()=>[...spaces].map(([id,v])=>({id,...v}))};
function start(){service=researchDocuments(directory,workspace)}
async function call(url,bytes=Buffer.alloc(0),method='GET',type='application/octet-stream',headers={}){const req=Readable.from([bytes]);Object.assign(req,{url,method,headers:{'content-type':type,...headers}});let result;await service.handle(req,(status,data)=>result={status,data},(status,code,message)=>result={status,code,message},(filename,bytes,hash)=>result={status:200,filename,bytes,hash});return result}
async function test(name,fn){await fn();results.push(name);console.log('PASS',name)}
function pdf(pages,text='Synthetic audit text'){const objects=['<< /Type /Catalog /Pages 2 0 R >>',''];const kids=[];for(let i=0;i<pages;i++){const p=objects.length+1;kids.push(`${p} 0 R`);objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${p+1} 0 R >>`);const stream=`BT /F1 12 Tf 10 280 Td (${text}) Tj ET`;objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)}objects[1]=`<< /Type /Pages /Count ${pages} /Kids [${kids.join(' ')}] >>`;let output='%PDF-1.7\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${o}\nendobj\n`});const xref=Buffer.byteLength(output);output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(output)}
try{start();let id,folder;
await test('UTF-8 exact 1MiB accepted; over rejected',async()=>{assert.equal((await extractDocument(Buffer.alloc(L.textBytes,65),'txt')).text.length,L.textBytes);await assert.rejects(extractDocument(Buffer.alloc(L.textBytes+1,65),'txt'),{status:422})});
await test('8MiB+1 and malformed UTF-8 rejected',async()=>{await assert.rejects(extractDocument(Buffer.alloc(L.bytes+1),'pdf'),{status:413});await assert.rejects(extractDocument(Buffer.from([0xc0,0xaf]),'txt'),{status:422})});
await test('40 PDF pages accepted, 41 rejected',async()=>{assert.equal((await extractDocument(pdf(40),'pdf')).pages,40);await assert.rejects(extractDocument(pdf(41),'pdf'),{status:422})});
await test('Immutable source bytes and hash persist across restart',async()=>{const bytes=Buffer.from('\ufeff# Synthetic <script>alert(1)</script>\r\n');const r=await call('/api/documents/upload?name=synthetic.md',bytes,'POST');assert.equal(r.status,201);id=r.data.document.id;service.close();start();const downloaded=await call(`/api/documents/${id}/download`,undefined,'GET','application/octet-stream',{'x-document-store-id':(await call('/api/documents/choices')).data.uploadScope});assert.deepEqual(downloaded.bytes,bytes);assert.equal(downloaded.hash,createHash('sha256').update(bytes).digest('hex'));assert.equal((await call(`/api/documents/${id}`)).status,200)});
await test('Workspace/folder validation and stale reporting',async()=>{const f=await call('/api/documents/folders',Buffer.from(JSON.stringify({name:'Synthetic folder',workspaceId:'w1'})),'POST','application/json');assert.equal(f.status,201);folder=f.data.folder.id;assert.equal((await call(`/api/documents/upload?name=a.txt&workspaceId=w2&folderId=${folder}`,Buffer.from('a'),'POST')).status,409);const r=await call(`/api/documents/upload?name=a.txt&workspaceId=w1&folderId=${folder}`,Buffer.from('a'),'POST');assert.equal(r.status,201);spaces.delete('w1');assert.equal((await call(`/api/documents/${r.data.document.id}`)).data.document.stale,true)});
await test('Concurrent same-instance upload rejected and gate released',async()=>{let release;const blocked=new Promise(r=>release=r);const req=Readable.from((async function*(){await blocked;yield Buffer.from('synthetic')})());Object.assign(req,{url:'/api/documents/upload?name=slow.txt',method:'POST',headers:{'content-type':'application/octet-stream'}});let result;const first=service.handle(req,(status)=>result=status,()=>{},()=>{});assert.equal((await call('/api/documents/upload?name=other.txt',Buffer.from('a'),'POST')).status,429);release();await first;assert.equal(result,201);assert.equal((await call('/api/documents/upload?name=after.txt',Buffer.from('a'),'POST')).status,201)});
await test('Chunked oversize upload HTTP behavior',async()=>{const server=createServer(async(req,res)=>{await service.handle(req,(status,data)=>{res.writeHead(status);res.end(JSON.stringify(data))},(status,code,message)=>{res.writeHead(status);res.end(JSON.stringify({code,message}))},()=>{})});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const body=Readable.from((async function*(){for(let i=0;i<129;i++)yield Buffer.alloc(65536,65)})());const response=await fetch(`http://127.0.0.1:${server.address().port}/api/documents/upload?name=large.txt`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body,duplex:'half'});console.log('OBSERVATION chunked excess',response.status,await response.text());assert.equal(response.status,413)}finally{server.closeAllConnections();await new Promise(r=>server.close(r))}});
await test('SQL triggers protect every immutable content column and deletion; metadata remains mutable',async()=>{
 const db=new DatabaseSync(join(directory,'research-documents.sqlite'));
 try{
  const before=db.prepare('SELECT * FROM research_documents ORDER BY id').all();assert.ok(before.length);
  for(const column of ['id','format','bytes','sha256','text_sha256','created','pages','original','text','text_bytes']){
   assert.throws(()=>db.exec(`UPDATE research_documents SET ${column}=${column}`),/Immutable document content/,column);
  }
  assert.throws(()=>db.exec('DELETE FROM research_documents'),/Immutable documents/);
  // The current document-management increment intentionally permits metadata edits.
  // Its HTTP suite separately verifies revisions, validation, trash and restore.
  for(const column of ['name','workspace_id','folder_id','search_value','revision','trashed_at']){
   assert.doesNotThrow(()=>db.exec(`UPDATE research_documents SET ${column}=${column}`),column);
  }
  assert.deepEqual(db.prepare('SELECT * FROM research_documents ORDER BY id').all(),before);
 }finally{db.close()}
});
await test('250-document count quota survives restart',async()=>{const current=(await call('/api/documents')).data.total;for(let i=current;i<250;i++)assert.equal((await call(`/api/documents/upload?name=quota-${i}.txt`,Buffer.from('synthetic'),'POST')).status,201);assert.equal((await call('/api/documents/upload?name=excess.txt',Buffer.from('synthetic'),'POST')).status,429);service.close();start();assert.equal((await call('/api/documents')).data.total,250);assert.equal((await call('/api/documents/upload?name=excess-after-restart.txt',Buffer.from('synthetic'),'POST')).status,429)});
await test('64MiB aggregate source/text quota rejects excess',async()=>{service.close();const quotaDir=await mkdtemp(join(tmpdir(),'document-quota-audit-'));service=researchDocuments(quotaDir,workspace);try{const block=Buffer.alloc(L.textBytes,65);for(let i=0;i<64;i++)assert.equal((await call(`/api/documents/upload?name=megabyte-${i}.txt`,block,'POST')).status,201);assert.equal((await call('/api/documents/upload?name=excess-byte.txt',Buffer.from('x'),'POST')).status,429);assert.equal((await call('/api/documents')).data.total,64)}finally{service.close();service=null;await rm(quotaDir,{recursive:true,force:true})}});
console.log(JSON.stringify({passed:results.length,results}));}finally{service?.close();await rm(directory,{recursive:true,force:true})}
