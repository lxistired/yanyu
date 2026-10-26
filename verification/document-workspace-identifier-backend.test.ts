// @vitest-environment node
// Actual WorkspaceDomain, SQLite, production handlers; synthetic text only, no HTTP.
import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {DomainStore} from '../backend/source/server/workspace-store';
import {WorkspaceDomain} from '../backend/source/server/workspace-domain';
import {researchDocuments} from '../backend/research-documents.mjs';
it('prefixed workspace folder, upload, receipt replay, list and metadata retain scope, owner and revision guards',async()=>{
 const root=mkdtempSync(join(tmpdir(),'document-workspace-synthetic-')),store=new DomainStore(root),domain=new WorkspaceDomain(store);
 const context=(subjectId:string)=>({principal:{tenantId:'synthetic',subjectId,collectionIds:['synthetic']},signal:new AbortController().signal,requestId:'document-identifier'});
 const owner=context('owner'),other=context('other');
 const bridge={get:(kind:any,id:string)=>domain.get(owner,{kind,id}),list:(kind:any)=>domain.list(owner,{kind,limit:200}).items};
 const docs=researchDocuments(root,bridge);
 const call=async(url:string,method='GET',data?:unknown,headers:Record<string,string>={})=>{let answer:any;const bytes=typeof data==='string'?Buffer.from(data):data===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(data));const req=Object.assign(Readable.from([bytes]),{url,method,headers:{...(data!==undefined?{'content-type':typeof data==='string'?'application/octet-stream':'application/json'}:{}),...headers}});await docs.handle(req,(status:number,body:any)=>answer={status,body},(status:number,code:string)=>answer={status,code},()=>{throw Error('Unexpected download')},()=>{throw Error('Unexpected image')});return answer;};
 try{
  for(const id of ['_workspace','-workspace','_'+'a'.repeat(99),'__proto__'])domain.create(owner,{kind:'workspace',id,data:{name:id},idempotencyKey:randomUUID()});
  domain.create(other,{kind:'workspace',id:'_private',data:{name:'Private'},idempotencyKey:randomUUID()});
  const choices=await call('/api/documents/choices'),scope=choices.body.uploadScope;expect(choices.body.workspaces.map((w:any)=>w.id)).toContain('_workspace');expect(choices.body.workspaces.map((w:any)=>w.id)).not.toContain('_private');
  for(const workspaceId of ['_workspace','-workspace','_'+'a'.repeat(99),'__proto__'])expect(await call('/api/documents/folders','POST',{name:'Synthetic',workspaceId})).toMatchObject({status:201,body:{folder:{workspaceId}}});
  const folders=(await call('/api/documents/choices')).body.folders,folder=folders.find((f:any)=>f.workspaceId==='_workspace').id,second=folders.find((f:any)=>f.workspaceId==='-workspace').id;
  const url='/api/documents/upload?'+new URLSearchParams({name:'synthetic.txt',workspaceId:'_workspace',folderId:folder}),headers={'x-upload-store-id':scope,'x-upload-operation-id':randomUUID()};
  const uploaded=await call(url,'POST','Synthetic text only',headers);expect(uploaded).toMatchObject({status:201,body:{document:{workspaceId:'_workspace',folderId:folder,revision:0,stale:false}}});
  const id=uploaded.body.document.id,hash=uploaded.body.document.sha256;expect(await call(url,'POST','Synthetic text only',headers)).toMatchObject({status:201,body:{document:{id}}});expect(await call(url,'POST','Different text',headers)).toMatchObject({status:409});
  expect(await call(url,'POST','Synthetic text only',{...headers,'x-upload-store-id':randomUUID()})).toMatchObject({status:409});
  expect(await call('/api/documents?workspaceId=_workspace')).toMatchObject({status:200,body:{total:1}});
  const metadata=(workspaceId:any,folderId:any,revision=0)=>({name:'Renamed',workspaceId,folderId,revision});const path=`/api/documents/${id}/metadata`;
  expect(await call(path,'PUT',metadata('-workspace',folder))).toMatchObject({status:409});expect(await call(path,'PUT',metadata('_private',null))).toMatchObject({status:409,code:'CONFLICT'});
  expect(await call(path,'PUT',metadata('-workspace',second))).toMatchObject({status:200,body:{document:{revision:1,workspaceId:'-workspace',sha256:hash}}});expect(await call(path,'PUT',metadata(null,null))).toMatchObject({status:409});
  expect(await call('/api/documents?workspaceId=-workspace')).toMatchObject({status:200,body:{total:1}});expect(await call('/api/documents?workspaceId=_workspace')).toMatchObject({status:200,body:{total:0}});
  for(const invalid of ['', '_'+ 'a'.repeat(100),'_.','a/b','a\n','a\r','a\u2028','a\u2029']){
   expect(await call('/api/documents/folders','POST',{name:'Invalid',workspaceId:invalid})).toMatchObject({status:400});expect(await call('/api/documents?'+new URLSearchParams({workspaceId:invalid}))).toMatchObject({status:400});expect(await call(path,'PUT',metadata(invalid,null,1))).toMatchObject({status:400});expect(await call('/api/documents/upload?'+new URLSearchParams({name:'synthetic.txt',workspaceId:invalid}),'POST','Synthetic')).toMatchObject({status:400});
  }
  for(const legacy of ['a.b:c','a'.repeat(160)])expect(await call('/api/documents?'+new URLSearchParams({workspaceId:legacy}))).toMatchObject({status:200,body:{total:0}});
  expect(await call('/api/documents?workspaceId=-workspace','GET',undefined,{'x-document-store-id':randomUUID()})).toMatchObject({status:409});
  expect(await call(path,'PUT',metadata(null,null,1))).toMatchObject({status:200,body:{document:{revision:2,workspaceId:null,folderId:null,sha256:hash}}});
 }finally{docs.close();store.close();rmSync(root,{recursive:true,force:true})}
});
