// @vitest-environment node
// Real synthetic PDF extraction/raster/SQLite; the controlled completion gate is
// a simulated race, not a browser, device, HTTP, or production permission test.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
const control=vi.hoisted(()=>({calls:0,afterImage:null as null|(()=>Promise<void>)}));
vi.mock('../backend/pdf-page-reader.mjs',async importOriginal=>{
 const real:any=await importOriginal();return {...real,pdfPageReader(...args:any[]){const reader=real.pdfPageReader(...args);return {...reader,async image(...input:any[]){control.calls++;const bytes=await reader.image(...input);if(control.afterImage)await control.afterImage();return bytes}}}};
});
import {researchDocuments} from '../backend/research-documents.mjs';
import {publishPdfImage} from '../backend/pdf-image-response.mjs';
import {generatedPdf} from '../backend/synthetic-reader-pdf.mjs';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
let root:string,docs:any,doc:any,scope:string,denied:boolean,missing:boolean,folderId:string;
const gate=()=>{let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>{release=r}),arrived=new Promise<void>(r=>{entered=r});return {release,arrived,hold:async()=>{entered();await waiting}}};
function mutate(sql:string,...values:any[]){const db=new DatabaseSync(join(root,'research-documents.sqlite'));try{return db.prepare(sql).run(...values)}finally{db.close()}}
function stateCount(){const db=new DatabaseSync(join(root,'research-documents.sqlite'));try{return db.prepare('SELECT count(*) AS n FROM document_reader_state').get()!.n}finally{db.close()}}
async function request(method:string,url:string,data?:any,options:any={}){
 const bytes=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data??{}));const req:any=options.req??Readable.from([bytes]);req.method=method;req.url=url;req.headers=options.headers??{'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json','x-document-store-id':scope};
 let result:any,count=0;await docs.handle(req,(status:number,body:any)=>{count++;result={status,body}},(status:number,code:string,message:string)=>{count++;result={status,code,message}},()=>{throw Error('Unexpected download')},(image:Buffer,identity:any,check:()=>void)=>{options.beforePublication?.();check();count++;result={status:200,image,identity}});expect(count).toBe(1);return result;
}
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'pdf-preview-authority-'));denied=false;missing=false;control.calls=0;control.afterImage=null;
 docs=researchDocuments(root,{get(_kind:string,id:string){if(denied)throw Object.assign(Error('Synthetic workspace access withdrawn'),{code:'FORBIDDEN'});if(missing)throw Object.assign(Error('Synthetic workspace removed'),{code:'NOT_FOUND'});return {id,revision:1,data:{name:'Synthetic workspace'}}},list:()=>[]});
 scope=(await request('GET','/api/documents/choices')).body.uploadScope;
 folderId=(await request('POST','/api/documents/folders',{workspaceId:'synthetic-workspace',name:'Synthetic folder'})).body.folder.id;
 const result=await request('POST','/api/documents/upload?'+new URLSearchParams({name:'synthetic-preview.pdf',workspaceId:'synthetic-workspace',folderId}),generatedPdf(2));expect(result.status).toBe(201);doc=result.body.document;
});
afterEach(()=>{control.afterImage=null;vi.restoreAllMocks();docs?.close();rmSync(root,{recursive:true,force:true})});
const pageUrl=()=>`/api/documents/${doc.id}/page?page=1&scale=100&storeScope=${scope}`;
const readerUrl=()=>`/api/documents/${doc.id}/reader`;
it('renders exact synthetic PDF bytes with frozen response identity; legacy unbound request still internally checked',async()=>{
 const r=await request('GET',pageUrl());expect(r.status).toBe(200);expect(r.image.length).toBeGreaterThan(45);expect(Object.isFrozen(r.identity)).toBe(true);
 expect(r.identity).toEqual({storeScope:scope,documentId:doc.id,sha256:doc.sha256,pages:2,page:1,scale:100,imageSha256:hash(r.image)});
 const legacy=await request('GET',`/api/documents/${doc.id}/page?page=1&scale=100`,undefined,{headers:{}});expect(legacy.status).toBe(200);expect(legacy.image.equals(r.image)).toBe(true);
 const state=await request('GET',readerUrl());expect(state.body).toEqual({page:1,bookmark:null,scale:100,pages:2,sha256:doc.sha256,storeScope:scope});
 expect((await request('PUT',readerUrl(),{page:2,bookmark:1,scale:150})).status).toBe(200);expect(stateCount()).toBe(1);
},15000);
it.each(['GET-page','GET-reader','PUT-reader'])('denied workspace rejects %s before original allocation, raster or state change',async lane=>{
 denied=true;const sql:string[]=[];const original=DatabaseSync.prototype.prepare;vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,query:string){sql.push(query);return original.call(this,query)});
 const r=await request(lane.startsWith('PUT')?'PUT':'GET',lane.endsWith('page')?pageUrl():readerUrl(),{page:2,bookmark:null,scale:100});expect(r.status).toBe(403);expect(control.calls).toBe(0);expect(sql.some(s=>/SELECT.*\boriginal\b/i.test(s))).toBe(false);expect(stateCount()).toBe(0);
});
it.each(['missing-workspace','missing-folder','wrong-folder'])('rejects initial %s association before raster',async change=>{
 if(change==='missing-workspace')missing=true;
 // A missing referenced folder cannot be constructed with the real FK intact.
 // Simulate only the read observation; never disable the SQLite constraint.
 if(change==='missing-folder'){const original=DatabaseSync.prototype.prepare;vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,query:string){if(query==='SELECT * FROM document_folders WHERE id=?')return {get:()=>undefined} as any;return original.call(this,query)})}
 if(change==='wrong-folder')mutate('UPDATE document_folders SET workspace_id=? WHERE id=?','different-workspace',folderId);
 expect((await request('GET',pageUrl())).status).toBe(409);expect(control.calls).toBe(0);
});
it.each(['denied','missing','folder-moved','document-moved','renamed','trashed','store-replaced','closed'])('holds actual raster completion then rejects changed %s without publishing pixels',async change=>{
 const g=gate();control.afterImage=g.hold;const pending=request('GET',pageUrl());await g.arrived;
 if(change==='denied')denied=true;
 if(change==='missing')missing=true;
 if(change==='folder-moved')mutate('UPDATE document_folders SET workspace_id=? WHERE id=?','different-workspace',folderId);
 if(change==='document-moved')mutate('UPDATE research_documents SET workspace_id=NULL,folder_id=NULL,revision=revision+1 WHERE id=?',doc.id);
 if(change==='renamed')mutate('UPDATE research_documents SET name=?,revision=revision+1 WHERE id=?','Renamed synthetic',doc.id);
 if(change==='trashed')mutate('UPDATE research_documents SET trashed_at=?,revision=revision+1 WHERE id=?',new Date().toISOString(),doc.id);
 if(change==='store-replaced')mutate('UPDATE document_upload_identity SET scope=? WHERE singleton=1',randomUUID());
 if(change==='closed')docs.close();
 g.release();const r=await pending;expect(r.status).toBe(change==='denied'?403:change==='trashed'?404:change==='closed'?503:409);expect(r.image).toBeUndefined();expect(control.calls).toBe(1);
},15000);
it('checks synchronous publication callback again, not only completion of raster',async()=>{
 const r=await request('GET',pageUrl(),undefined,{beforePublication:()=>{denied=true}});expect(r.status).toBe(403);expect(r.image).toBeUndefined();
},15000);
it.each(['denied','moved','trashed','store-replaced'])('delayed PUT body with changed %s never saves position',async change=>{
 const g=gate();const req=Readable.from((async function*(){await g.hold();yield Buffer.from(JSON.stringify({page:2,bookmark:1,scale:150}))})());
 const pending=request('PUT',readerUrl(),undefined,{req});await g.arrived;
 if(change==='denied')denied=true;
 if(change==='moved')mutate('UPDATE research_documents SET workspace_id=NULL,folder_id=NULL,revision=revision+1 WHERE id=?',doc.id);
 if(change==='trashed')mutate('UPDATE research_documents SET trashed_at=?,revision=revision+1 WHERE id=?',new Date().toISOString(),doc.id);
 if(change==='store-replaced')mutate('UPDATE document_upload_identity SET scope=? WHERE singleton=1',randomUUID());
 g.release();const r=await pending;expect(r.status).toBe(change==='denied'?403:change==='trashed'?404:409);expect(stateCount()).toBe(0);
});
it('rejects replaced store even with legacy headerless request before raster',async()=>{mutate('UPDATE document_upload_identity SET scope=? WHERE singleton=1',randomUUID());const r=await request('GET',`/api/documents/${doc.id}/page?page=1&scale=100`,undefined,{headers:{}});expect(r.status).toBe(409);expect(r.code).toBe('DOCUMENT_STORE_MISMATCH');expect(control.calls).toBe(0)});
it('withdrawn access also blocks already cached pixels',async()=>{expect((await request('GET',pageUrl())).status).toBe(200);denied=true;expect((await request('GET',pageUrl())).status).toBe(403);expect(control.calls).toBe(1)},15000);

// Pure publisher unit checks use synthetic bytes, not raster/HTTP acceptance.
it('publisher rejects malformed identity or deferred authorization before headers',()=>{
 const bytes=Buffer.alloc(45),identity={storeScope:scope,documentId:doc.id,sha256:doc.sha256,pages:2,page:1,scale:100,imageSha256:hash(bytes)};
 const res={writeHead:vi.fn(),end:vi.fn()};
 const cases=[{...identity,storeScope:scope+'\r\nX-Bad: yes'},{...identity,documentId:'invalid'},{...identity,sha256:'A'.repeat(64)},{...identity,pages:41},{...identity,page:3},{...identity,scale:'100'},{...identity,imageSha256:'0'.repeat(64)},{...identity,extra:true}];
 for(const item of cases)expect(()=>publishPdfImage(res,bytes,Object.freeze(item),()=>{})).toThrow();
 expect(()=>publishPdfImage(res,bytes,identity,()=>{})).toThrow();
 const valid=Object.freeze(identity);
 expect(()=>publishPdfImage(res,Buffer.alloc(44),valid,()=>{})).toThrow();
 expect(()=>publishPdfImage(res,bytes,valid,async()=>{})).toThrow();
 expect(()=>publishPdfImage(res,bytes,valid,()=>Promise.resolve())).toThrow();
 expect(()=>publishPdfImage(res,bytes,valid,()=>{throw Error('revoked')})).toThrow();
 expect(res.writeHead).not.toHaveBeenCalled();expect(res.end).not.toHaveBeenCalled();
 publishPdfImage(res,bytes,valid,()=>{});expect(res.writeHead).toHaveBeenCalledExactlyOnceWith(200,expect.objectContaining({'Content-Type':'image/png','Content-Length':45,'X-Document-Store-Id':scope,'X-Document-Id':doc.id,'X-Document-Sha256':doc.sha256,'X-Document-Pages':'2','X-Document-Page':'1','X-Document-Scale':'100','X-Image-Sha256':hash(bytes)}));expect(res.end).toHaveBeenCalledExactlyOnceWith(bytes);
});
