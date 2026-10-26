// SOURCE ONLY, no execution authorized in this handoff. Generated local SQLite
// fixtures only. The integrator must admit the P emitted module before running.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {researchDocuments} from '../../backend/research-documents.mjs';
const protocol={...await import(process.env.MANUAL_INVENTORY_PROTOCOL_MODULE),sha256Utf8:s=>createHash('sha256').update(s).digest('hex')};
const all={mode:'all',workspaceId:null,folderId:null};
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'manual-inventory-synthetic-'));
 const service=researchDocuments(root,{get(){throw Object.assign(Error('missing'),{code:'NOT_FOUND'})}});
 const writer=new DatabaseSync(join(root,'research-documents.sqlite'));
 const authority={assertCurrent(){},workspaceExists(ctx,id,budget){budget.check();budget.charge(16,1);return id==='workspace-a'},monotonicNow:()=>performance.now(),now:()=>new Date().toISOString(),error:code=>Object.assign(Error(code),{code})};
 const {observer,probe}=service.createManualInventoryObserverPort(authority,protocol);
 const scope=probe({}).documentStoreScope;assert.equal(typeof scope,'string');
 const budget={check(){},charge(){}};
 const add=(n,{name='synthetic.md',workspaceId=null,folderId=null}={})=>writer.prepare('INSERT INTO research_documents(id,name,format,bytes,sha256,text_sha256,created,pages,workspace_id,folder_id,original,text,search_value,text_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id(n),name,'md',1,'a'.repeat(64),'b'.repeat(64),'2026-10-22T00:00:00.000Z',null,workspaceId,folderId,Buffer.from('x'),'x','x',1);
 return {root,service,writer,observer,probe,budget,add,input:(selection=all)=>({documentStoreScope:scope,selection}),close(){writer.close();service.close();rmSync(root,{recursive:true,force:true})}};
}
const fails=(fn,code)=>assert.throws(fn,e=>e.code===code);
test('SQLite exact all/unassigned/folder scopes and bounded associative lookup',()=>{
 const f=fixture();try{
  f.writer.prepare('INSERT INTO document_folders VALUES(?,?,?,?)').run(id(8),'fixture folder',null,'2026-10-22T00:00:00.000Z');
  f.add(1);f.add(2,{workspaceId:'workspace-a'});f.add(3,{folderId:id(8)});
  for(const [selection,expected] of [[all,[id(1),id(2),id(3)]],[{mode:'workspace',workspaceId:null,folderId:null},[id(1),id(3)]],[{mode:'folder',workspaceId:null,folderId:id(8)},[id(3)]]]){
   const o=f.observer.observe({},f.input(selection),f.budget);assert.deepEqual(o.rows.map(r=>r.id),expected);o.checkCurrent();o.close();
  }
  fails(()=>f.observer.observe({},f.input({mode:'folder',workspaceId:'workspace-a',folderId:id(8)}),f.budget),'SELECTION_CONFLICT');
 }finally{f.close()}
});
test('SQLite oversized/wrong-type text is refused before returning a row',()=>{
 for(const name of ['x'.repeat(513),Buffer.alloc(20000,65)]){const f=fixture();try{f.add(1,{name});fails(()=>f.observer.observe({},f.input(),f.budget),'INVALID_METADATA')}finally{f.close()}}
});
test('SQLite historical authorization ignores rename/revision but rejects trash',()=>{
 const f=fixture();try{
  f.add(1);const captured=f.observer.observe({},f.input(),f.budget);const saved=captured.rows;captured.close();
  f.writer.prepare('UPDATE research_documents SET name=?,revision=revision+1 WHERE id=?').run('renamed.md',id(1));
  const access=f.observer.authorizeHistorical({},{...f.input(),rows:saved},f.budget);
  f.writer.prepare('UPDATE research_documents SET trashed_at=? WHERE id=?').run('2026-10-22T00:01:00.000Z',id(1));
  fails(()=>access.checkAccess(),'RESULT_ACCESS_UNAVAILABLE');access.close();
 }finally{f.close()}
});
test('SQLite live identity changes and path replacement revoke publication',()=>{
 for(const change of [f=>f.writer.prepare('UPDATE document_upload_identity SET scope=? WHERE singleton=1').run(id(99)),f=>renameSync(join(f.root,'research-documents.sqlite'),join(f.root,'replaced.sqlite'))]){
  const f=fixture();try{f.add(1);const o=f.observer.observe({},f.input(),f.budget);change(f);fails(()=>o.checkCurrent(),'SOURCE_UNAVAILABLE');assert.deepEqual(f.probe({}),{available:false,documentStoreScope:null});o.close()}finally{f.close()}
 }
});
test('each read snapshot is ended before publication recheck; source closed fails',()=>{
 const f=fixture();try{
  f.add(1);const o=f.observer.observe({},f.input(),f.budget);
  f.writer.prepare('UPDATE research_documents SET name=?,revision=revision+1 WHERE id=?').run('changed.md',id(1));
  fails(()=>o.checkCurrent(),'INVENTORY_CHANGED');f.service.close();assert.equal(f.probe({}).available,false);o.close();
 }finally{f.close()}
});
