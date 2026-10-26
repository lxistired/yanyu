// SOURCE ONLY: not executed. Integration supplies the reviewed emitted P module
// via MANUAL_INVENTORY_PROTOCOL_MODULE (absolute file URL); no private fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createManualInventoryObserver} from '../../backend/manual-inventory-observer.mjs';
const protocol={...await import(process.env.MANUAL_INVENTORY_PROTOCOL_MODULE),sha256Utf8:s=>createHash('sha256').update(s).digest('hex')};
const scope='11111111-1111-4111-8111-111111111111';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const all=Object.freeze({mode:'all',workspaceId:null,folderId:null});
const row=(n=1,patch={})=>({id:id(n),name:'synthetic 文档.md',format:'md',bytes:5,sha256:'a'.repeat(64),textSha256:'b'.repeat(64),createdAt:'2026-10-22T00:00:00.000Z',pages:null,workspaceId:null,folderId:null,revision:0,...patch});
function fixture(initial=[row()]){
 let rows=initial,liveScope=scope,time=0,owner=true,live=true,inRead=false,visits=0,charged=0,records=0;
 const workspaces=new Set(['workspace-a','workspace-b']);const folders=new Map();
 const authority={assertCurrent(){assert.equal(inRead||visits===0,true);if(!owner)throw Error('private owner diagnostic')},workspaceExists(ctx,id,budget){budget.check();budget.charge(16,1);return workspaces.has(id)},monotonicNow:()=>time,now:()=> '2026-10-22T00:00:00.000Z',error:code=>Object.assign(Error(code),{code})};
 const access={live(scalar){scalar();if(!live)throw Error('private storage path');return liveScope},read(fn){assert.equal(inRead,false);inRead=true;try{return fn()}finally{inRead=false}},visit(selection,accept){visits++;for(const r of rows){if(selection.mode!=='all'&&r.workspaceId!==selection.workspaceId)continue;if(selection.mode==='folder'&&r.folderId!==selection.folderId)continue;accept({...r,metadata_valid:1})}},folder:id=>folders.get(id),historical:id=>{const r=rows.find(r=>r.id===id);return r?{id:r.id,workspaceId:r.workspaceId,folderId:r.folderId,active:1,metadata_valid:1}:undefined}};
 for(const key of ['text','original','resolve'])Object.defineProperty(access,key,{get(){throw Error('Content capability must never be read')}});
 const observer=createManualInventoryObserver(access,authority,protocol);
 const budget={check(){},charge(b,r=0){charged+=b;records+=r}};
 return {observer,budget,folders,workspaces,input:(selection=all)=>({documentStoreScope:scope,selection}),setRows:x=>rows=x,setScope:x=>liveScope=x,setTime:x=>time=x,setOwner:x=>owner=x,setLive:x=>live=x,stats:()=>({visits,charged,records})};
}
const fails=(fn,code)=>assert.throws(fn,e=>e.code===code&&!e.message.includes('private'));
test('zero and 250 rows are valid; 251 refuses without partial observation',()=>{
 for(const n of [0,250]){const f=fixture(Array.from({length:n},(_,n)=>row(n)));const o=f.observer.observe({},f.input(),f.budget);assert.equal(o.rows.length,n);assert(Object.isFrozen(o.rows));o.checkCurrent();o.close()}
 const f=fixture(Array.from({length:251},(_,n)=>row(n)));fails(()=>f.observer.observe({},f.input(),f.budget),'INVENTORY_TOO_LARGE');
});
test('exact explicit null semantics: all versus unassigned workspace and folder',()=>{
 const folder=id(777),f=fixture([row(1),row(2,{workspaceId:'workspace-a'}),row(3,{folderId:folder})]);f.folders.set(folder,{id:folder,workspaceId:null,metadata_valid:1});
 for(const [selection,count] of [[all,3],[{mode:'workspace',workspaceId:null,folderId:null},2],[{mode:'folder',workspaceId:null,folderId:folder},1]]){const o=f.observer.observe({},f.input(selection),f.budget);assert.equal(o.rows.length,count);o.close()}
 for(const selection of [{mode:'all',workspaceId:'workspace-a',folderId:null},{mode:'workspace',workspaceId:null},{mode:'folder',workspaceId:null,folderId:''}])fails(()=>f.observer.observe({},f.input(selection),f.budget),'INVALID_REQUEST');
});
test('missing scopes, stale and unauthorized row associations refuse whole capture',()=>{
 const f=fixture();fails(()=>f.observer.observe({},f.input({mode:'workspace',workspaceId:'missing',folderId:null}),f.budget),'SELECTION_CONFLICT');
 f.setRows([row(1,{workspaceId:'missing'})]);fails(()=>f.observer.observe({},f.input(),f.budget),'INVALID_METADATA');
 f.setRows([row(1,{folderId:id(99)})]);fails(()=>f.observer.observe({},f.input(),f.budget),'INVALID_METADATA');
});
test('duplicate, unsorted and invalid metadata fail',()=>{
 for(const data of [[row(2),row(1)],[row(),row()],[row(1,{name:'bad/name'})],[row(1,{bytes:0})],[row(1,{revision:-0})]]){const f=fixture(data);fails(()=>f.observer.observe({},f.input(),f.budget),'INVALID_METADATA')}
});
test('metadata or membership edits invalidate publication but never replace captured rows',()=>{
 for(const change of [old=>[...old,row(2)],old=>old.map(r=>({...r,name:'renamed'})),()=>[]]){const f=fixture(),o=f.observer.observe({},f.input(),f.budget);f.setRows(change([row()]));fails(()=>o.checkCurrent(),'INVENTORY_CHANGED');assert.equal(o.rows[0].name,'synthetic 文档.md');o.close()}
});
test('historical access tolerates metadata changes and newly added documents',()=>{
 const f=fixture(),saved=[row()];f.setRows([row(1,{name:'new name',revision:9,sha256:'c'.repeat(64)}),row(2)]);
 const o=f.observer.authorizeHistorical({},{...f.input(),rows:saved},f.budget);o.checkAccess();o.close();assert.equal(f.stats().visits,0);
});
test('historical access denies movement, disappearance and lost scope as a whole',()=>{
 for(const change of [()=>[],()=>[row(1,{workspaceId:'workspace-a'})]]){const f=fixture(),o=f.observer.authorizeHistorical({},{...f.input(),rows:[row()]},f.budget);f.setRows(change());fails(()=>o.checkAccess(),'RESULT_ACCESS_UNAVAILABLE')}
});
test('changed live identity, closure and authority fail at publication',()=>{
 for(const mutate of [f=>f.setScope(id(888)),f=>f.setLive(false),f=>f.setOwner(false)]){const f=fixture(),o=f.observer.observe({},f.input(),f.budget);mutate(f);fails(()=>o.checkCurrent(),'SOURCE_UNAVAILABLE')}
 const f=fixture(),o=f.observer.observe({},f.input(),f.budget);o.close();fails(()=>o.checkCurrent(),'SOURCE_UNAVAILABLE');
});
test('deadline, bounded passes and caller budget fail closed',()=>{
 const f=fixture(),o=f.observer.observe({},f.input(),f.budget);f.setTime(5001);fails(()=>o.checkCurrent(),'BUDGET_EXCEEDED');
 const g=fixture(),p=g.observer.observe({},g.input(),g.budget);p.checkCurrent();p.checkCurrent();fails(()=>p.checkCurrent(),'BUDGET_EXCEEDED');
 const h=fixture();fails(()=>h.observer.observe({},h.input(),{check(){throw Error('stop')},charge(){}}),'BUDGET_EXCEEDED');
});
test('caller mutation cannot alter saved historical association or frozen selection',()=>{
 const f=fixture(),saved=[row()],input=f.input({...all}),o=f.observer.observe({},input,f.budget);input.selection.mode='workspace';assert.equal(o.selection.mode,'all');o.close();
 const access=f.observer.authorizeHistorical({},{...f.input(),rows:saved},f.budget);saved[0].workspaceId='workspace-a';access.checkAccess();access.close();
});

test('canonical expanded-year metadata remains eligible',()=>{const f=fixture([row(1,{createdAt:'+010000-01-01T00:00:00.000Z'})]);const o=f.observer.observe({},f.input(),f.budget);assert.equal(o.rows[0].createdAt,'+010000-01-01T00:00:00.000Z');o.close()});
