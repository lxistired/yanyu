// @vitest-environment node
// Real domain, SQLite and handlers with synthetic requests. No HTTP listener/media/worker.
import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {DomainStore} from '../backend/source/server/workspace-store';
import {WorkspaceDomain} from '../backend/source/server/workspace-domain';
import {relationshipIdentifier} from '../backend/relationship-identifier.mjs';
import {transcriptRelationships} from '../backend/transcript-relationships.mjs';
import {transcriptionLibrary} from '../backend/transcription-library.mjs';

it('accepts exactly the legacy/domain union with absolute ends; no new punctuation or overlength prefixes',()=>{
 for(const value of ['a','_','-','_workspace','-session','a.b:c-d_','a'.repeat(160),'_'+'a'.repeat(99)])expect(relationshipIdentifier(value)).toBe(true);
 for(const value of ['',null,[],{},1,'a'.repeat(161),'_'+'a'.repeat(100),'_.','-a:b','a/b','a b','中','a\n','a\r','a\u2028','a\u2029','a\0'])expect(relationshipIdentifier(value)).toBe(false);
});

it('actual domain prefixed targets survive assignment, list filters, revisions, replay, owner and parent checks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relationship-id-synthetic-'));
 const store=new DomainStore(root),domain=new WorkspaceDomain(store),db=new DatabaseSync(':memory:');
 const context=(owner:string)=>({principal:{tenantId:'synthetic',subjectId:owner,collectionIds:['synthetic']},signal:new AbortController().signal,requestId:'identifier-test'});
 const owner=context('owner'),other=context('other');
 const bridge={get:(kind:any,id:string)=>domain.get(owner,{kind,id}),list:(kind:any)=>domain.list(owner,{kind,limit:200}).items};
 db.exec(`CREATE TABLE transcription_jobs(id TEXT PRIMARY KEY,filename TEXT,status TEXT,created TEXT,result TEXT,error TEXT,progress TEXT,requested_language TEXT,pending_expires_at INTEGER,deleted_at TEXT);
 CREATE TABLE transcript_corrections(job_id TEXT PRIMARY KEY,text TEXT);`);
 const relationships=transcriptRelationships(db,bridge),library=transcriptionLibrary(db,relationships);
 const job=randomUUID(),second=randomUUID();
 for(const id of [job,second])db.prepare('INSERT INTO transcription_jobs(id,filename,status,created,result) VALUES(?,?,?,?,?)').run(id,'synthetic.txt','completed','2026-10-21T00:00:00Z',JSON.stringify({text:'synthetic only'}));
 const create=(kind:any,id:string,data:any,ctx=owner)=>domain.create(ctx,{kind,id,data,idempotencyKey:randomUUID()});
 const call=async(body:any,id=job)=>{let answer:any;const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{url:`/api/local-asr/jobs/${id}/relationship`,method:'POST',headers:{'content-type':'application/json'}});await relationships.handle(req,(status:number,body:any)=>answer={status,body},(status:number,code:string)=>answer={status,code});return answer;};
 const command=(workspaceId:any,sessionId:any,expectedRevision=0)=>({workspaceId,sessionId,expectedRevision,idempotencyKey:randomUUID()});
 const list=(query:string)=>{let answer:any;library.list('/api/local-asr/jobs?'+query,(status:number,body:any)=>answer={status,body},(status:number,code:string)=>answer={status,code},null);return answer;};
 try{
  create('workspace','_workspace',{name:'Underscore'});create('workspace','-workspace',{name:'Hyphen'});
  create('session','-session',{title:'Hyphen',workspaceId:'_workspace'});create('session','_session',{title:'Underscore',workspaceId:'-workspace'});
  create('workspace','_private',{name:'Other owner'},other);create('session','-private',{title:'Other session',workspaceId:'_private'},other);
  const long='_'+'x'.repeat(99);create('workspace',long,{name:'Boundary'});create('workspace','__proto__',{name:'Literal ID'});
  let catalog:any;await relationships.handle({url:'/api/local-asr/relationships',method:'GET'},(_status:number,body:any)=>catalog=body,()=>{throw Error('choices failed')});
  expect(catalog.workspaces.map((w:any)=>w.id)).toContain('_workspace');expect(catalog.workspaces.map((w:any)=>w.id)).not.toContain('_private');
  expect(list('workspaceId='+long)).toMatchObject({status:200,body:{total:0}});
  const first=command('_workspace','-session');expect(await call(first)).toMatchObject({status:200,body:{relationship:{workspaceId:'_workspace',sessionId:'-session',revision:1,stale:false}}});
  expect(await call(first)).toMatchObject({status:200,body:{replayed:true,relationship:{revision:1}}});
  expect(await call(first,second)).toMatchObject({status:409});
  expect(list(new URLSearchParams({workspaceId:'_workspace',sessionId:'-session'}).toString())).toMatchObject({status:200,body:{total:1,jobs:[{id:job}]}});
  for(const body of [command('-workspace','-session',1),command('_private',null,1),command('_workspace','-private',1)])expect(await call(body)).toMatchObject({status:409});
  expect(await call(command(null,'-session',1))).toMatchObject({status:400});
  expect(await call(command('-workspace','_session',0))).toMatchObject({status:409});
  expect(await call(command('-workspace','_session',1))).toMatchObject({status:200,body:{relationship:{revision:2}}});
  expect(list('workspaceId=-workspace&sessionId=_session')).toMatchObject({status:200,body:{total:1}});
  await relationships.handle({url:'/api/local-asr/relationships',method:'GET'},(_status:number,body:any)=>catalog=body,()=>{throw Error('choices failed')});
  expect(catalog.workspaces.find((w:any)=>w.id==='-workspace').count).toBe(1);expect(catalog.sessions.find((s:any)=>s.id==='_session').count).toBe(1);
  for(const invalid of ['', '_'+ 'a'.repeat(100),'_.','a/b','a\n','a\u2028']){
   expect(await call(command(invalid,null,2))).toMatchObject({status:400});
   for(const key of ['workspaceId','sessionId'])expect(list(new URLSearchParams({[key]:invalid}).toString())).toMatchObject({status:400});
  }
  for(const legacy of ['a.b:c','a'.repeat(160)])expect(list('workspaceId='+legacy)).toMatchObject({status:200,body:{total:0}});
  expect(list('jobId=_workspace')).toMatchObject({status:400});expect(list('jobId=a.b:c')).toMatchObject({status:200});
  expect(list('workspaceId=_workspace&workspaceId=-workspace')).toMatchObject({status:400});
  expect(await call({...command(null,null,2),owner:'other'})).toMatchObject({status:400});
  expect(await call(JSON.parse(JSON.stringify(command(null,null,2)).replace('{','{"__proto__":{},')))).toMatchObject({status:400});
  expect(await call(command(null,null,2))).toMatchObject({status:200,body:{relationship:{workspaceId:null,sessionId:null,revision:3}}});
  expect(list('workspaceId=-workspace')).toMatchObject({status:200,body:{total:0}});
  expect(await call(command(long,null,3))).toMatchObject({status:200});
  expect(await call(command('__proto__',null,4))).toMatchObject({status:200,body:{relationship:{workspaceId:'__proto__'}}});
 }finally{db.close();store.close();rmSync(root,{recursive:true,force:true});}
});
