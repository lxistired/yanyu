// @vitest-environment node
// Actual synthetic PDF raster + SQLite + server publisher through simulated
// in-memory Response transport. Not HTTP, browser decoding, or a saved annotation.
import {expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {researchDocuments} from '../backend/research-documents.mjs';
import {publishPdfImage} from '../backend/pdf-image-response.mjs';
import {generatedPdf} from '../backend/synthetic-reader-pdf.mjs';
import {fetchPdfPageImage,PdfImageAuthorityError} from '../candidate/src/components/pdf-page-image';

it('binds actual published raster bytes to the real client and rejects changed identity and current denial',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pdf-binding-convergence-'));
 let denied=false;
 let docs:any;
 try{
 docs=researchDocuments(root,{get(_kind:string,id:string){if(denied)throw Object.assign(Error('Synthetic access withdrawn'),{code:'FORBIDDEN'});return {id,revision:1,data:{name:'Synthetic workspace'}}},list:()=>[]});
 }catch(error){rmSync(root,{recursive:true,force:true});throw error}
 let scope='';
 type Published={status:number;headers:Record<string,string>;bytes:Buffer};
 async function request(method:string,url:string,data?:Buffer|object){
  const bytes=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data??{}));
  const req:any=Readable.from([bytes]);req.method=method;req.url=url;
  req.headers={'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json','x-document-store-id':scope};
  let calls=0;let result:any;
  await docs.handle(req,(status:number,body:any)=>{calls++;result={status,body}},(status:number,code:string,message:string)=>{calls++;result={status,body:{code,message}}},()=>{throw Error('Unexpected download')},(image:Buffer,identity:any,check:()=>void)=>{
   let status=0;let headers:Record<string,string>={};
   publishPdfImage({writeHead(s:number,h:Record<string,string|number>){expect(status).toBe(0);status=s;headers=Object.fromEntries(Object.entries(h).map(([k,v])=>[k,String(v)]))},end(body:Buffer){calls++;result={status,headers,bytes:Buffer.from(body)}}},image,identity,check);
  });expect(calls).toBe(1);return result;
 }
 try{
  scope=(await request('GET','/api/documents/choices')).body.uploadScope;
  const uploaded=await request('POST','/api/documents/upload?'+new URLSearchParams({name:'synthetic-binding.pdf',workspaceId:'synthetic-workspace'}),generatedPdf(1));
  expect(uploaded.status).toBe(201);const document=uploaded.body.document;
  const selection={storeScope:scope,documentId:document.id,sha256:document.sha256,pages:1,page:1,scale:100 as const};
  const url=`/api/documents/${document.id}/page?page=1&scale=100&storeScope=${scope}`;
  let captured:Published|undefined;let currentChecks=0;
  const transport:typeof fetch=async(input,init)=>{
   expect(input).toBe(url);expect(init).toMatchObject({method:'GET',headers:{'X-Document-Store-Id':scope},cache:'no-store',redirect:'error',credentials:'same-origin'});
   const r=await request('GET',String(input));
   if(r.status!==200)return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}});
   captured=r;return new Response(new Uint8Array(r.bytes),{status:r.status,headers:r.headers});
  };
  const receipt=await fetchPdfPageImage(selection,new AbortController().signal,()=>{currentChecks++},transport);
  expect(captured).toBeDefined();const published=captured!;
  expect(published.bytes.length).toBeGreaterThan(45);
  expect(published.headers['Content-Length']).toBe(String(published.bytes.length));
  const digest=createHash('sha256').update(published.bytes).digest('hex');
  expect(published.headers['X-Image-Sha256']).toBe(digest);
  expect(receipt).toEqual({dataUrl:'data:image/png;base64,'+published.bytes.toString('base64'),imageSha256:digest,sourceUrl:url});
  expect(currentChecks).toBeGreaterThan(0);
  // Negative cases mutate only a captured real response, never the positive fixture.
  for(const [name,value] of [['X-Document-Store-Id',randomUUID()],['X-Document-Sha256','0'.repeat(64)],['X-Document-Page','2']]){
   const headers={...published.headers,[name]:value};
   const changed:typeof fetch=async()=>new Response(new Uint8Array(published.bytes),{status:published.status,headers});
   await expect(fetchPdfPageImage(selection,new AbortController().signal,()=>{},changed)).rejects.toBeInstanceOf(PdfImageAuthorityError);
  }
  denied=true;
  await expect(fetchPdfPageImage(selection,new AbortController().signal,()=>{},transport)).rejects.toBeInstanceOf(PdfImageAuthorityError);
 }finally{try{docs.close()}finally{rmSync(root,{recursive:true,force:true})}}
},30_000);
