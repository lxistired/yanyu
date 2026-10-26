// @vitest-environment node
// Actual synthetic PDF/SQLite handler DTOs, not HTTP or browser decoding.
import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {researchDocuments} from '../backend/research-documents.mjs';
import {generatedPdf} from '../backend/synthetic-reader-pdf.mjs';
import {pdfOpenSelectionFromDocument,samePdfOpenSelection} from '../candidate/src/components/pdf-open-selection';
it('validates actual list/detail revision-zero pins and rejects a changed metadata selection',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pdf-selection-convergence-'));let docs:any;
 try{
  docs=researchDocuments(root,{get(_kind:string,id:string){return{id,revision:1,data:{name:'Synthetic workspace'}}},list:()=>[]});let scope='';
  async function request(method:string,url:string,data?:unknown,citationScope=scope){const bytes=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data??{}));const req:any=Readable.from([bytes]);req.method=method;req.url=url;req.headers={'content-type':Buffer.isBuffer(data)?'application/octet-stream':'application/json','x-document-store-id':scope,'x-citation-store-id':citationScope};let result:any,count=0;await docs.handle(req,(status:number,body:unknown)=>{count++;result={status,body:JSON.parse(JSON.stringify(body))}},(status:number,code:string,message:string)=>{count++;result={status,body:{code,message}}},()=>{throw Error('Unexpected download')},()=>{throw Error('Unexpected raster')});expect(count).toBe(1);return result;}
  scope=(await request('GET','/api/documents/choices')).body.uploadScope;
  const folder=await request('POST','/api/documents/folders',{workspaceId:'synthetic-workspace',name:'Synthetic folder'});expect(folder.status).toBe(201);
  for(const associated of [false,true]){
   const query=new URLSearchParams({name:`synthetic-${associated}.pdf`});if(associated){query.set('workspaceId','synthetic-workspace');query.set('folderId',folder.body.folder.id)}
   const uploaded=await request('POST','/api/documents/upload?'+query,generatedPdf(1));expect(uploaded.status).toBe(201);const id=uploaded.body.document.id;
   const listing=await request('GET','/api/documents?view=active&offset=0&limit=10');expect(listing.status).toBe(200);
   const listPin=pdfOpenSelectionFromDocument(listing.body.documents.find((d:any)=>d.id===id),listing.body.storeScope);expect(listPin).not.toBeNull();expect(listPin!.revision).toBe(0);expect(Object.isFrozen(listPin)).toBe(true);expect(listPin!.workspaceId).toBe(associated?'synthetic-workspace':null);expect(listPin!.folderId).toBe(associated?folder.body.folder.id:null);
   const wrong=await request('GET',`/api/documents/${id}`,undefined,'30000000-0000-4000-8000-000000000003');expect(wrong.status).toBe(409);
   const detail=await request('GET',`/api/documents/${id}`);expect(detail.status).toBe(200);const detailPin=pdfOpenSelectionFromDocument(detail.body.document,detail.body.storeScope);expect(detailPin).toEqual(listPin);expect(samePdfOpenSelection(listPin!,detailPin!)).toBe(true);
   const changed=await request('PUT',`/api/documents/${id}/metadata`,{revision:0,name:'Renamed synthetic.pdf',workspaceId:listPin!.workspaceId,folderId:listPin!.folderId});expect(changed.status).toBe(200);
   const current=await request('GET',`/api/documents/${id}`);const currentPin=pdfOpenSelectionFromDocument(current.body.document,current.body.storeScope);expect(currentPin!.revision).toBe(1);expect(samePdfOpenSelection(listPin!,currentPin!)).toBe(false);expect(currentPin!.sha256).toBe(listPin!.sha256);
  }
 }finally{try{docs?.close()}finally{rmSync(root,{recursive:true,force:true})}}
},30_000);
