import './plan-session-link-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {ManualPlanClient,captureCommand}=await import('../candidate/src/components/manual-plan-client.ts');
const scope='a'.repeat(64),sessionLink={scope,workspaceId:'w',sessionId:'s',workspaceRevision:2,sessionRevision:3};
const request={id:'p',expectedRevision:4,scope,sessionLink,offset:0,limit:25};
const row={id:'m',kind:'message',revision:1,createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z',deletedAt:null,data:{sessionId:'s',role:'assistant',content:'Legacy manual text\u0001\ud800'}};
const envelope=()=>({scope,planId:'p',planRevision:4,sessionLink,workspace:{id:'w',title:'Same name',revision:2},session:{id:'s',title:'Same name',revision:3,workspaceId:'w',mode:'quick',model:'Saved label only'},items:[structuredClone(row)],total:1,offset:0,nextOffset:null});
function client(value=envelope(),status=200){const calls=[];return {calls,client:new ManualPlanClient(async(url,init)=>{calls.push({url,init,input:JSON.parse(init.body)});return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});})};}
test('readonly exact query preserves legacy manual content, no sequence invention or write capture',async()=>{
 const f=client();assert.deepEqual(await f.client.linkedSession(request),envelope());assert.deepEqual(f.calls[0].input,request);
 assert.equal(f.calls[0].url,'/api/manual-plans/linkedSession');assert.equal(f.calls[0].init.cache,'no-store');
 assert.equal(f.calls[0].init.credentials,'same-origin');assert.equal(f.calls[0].init.redirect,'error');
 assert.throws(()=>captureCommand('linkedSession','key',request));
});
test('strict envelope rejects wrong scope, plan, tuple, parent, changed revision and message session without fallback',async()=>{
 const changes=[v=>v.scope='b'.repeat(64),v=>v.planId='other',v=>v.planRevision++,v=>v.sessionLink={...sessionLink,sessionId:'other'},v=>v.workspace.revision++,v=>v.session.workspaceId='other',v=>v.session.revision++,v=>v.items[0].data.sessionId='other',v=>v.items[0].deletedAt=row.createdAt,v=>v.items[0].extra='unknown',v=>v.items[0].data.sequence=0,v=>v.items.push({...row}),v=>v.nextOffset=1,v=>v.total=2,v=>v.offset=1,v=>v.session.generatedTurns=[]];
 for(const change of changes){const value=envelope();change(value);const f=client(value);await assert.rejects(()=>f.client.linkedSession(request));assert.equal(f.calls.length,1);}
});
test('request validation precedes transport; old backend and excessive response are unavailable with no ordinary query',async()=>{
 const f=client();for(const bad of [{...request,scope:'b'.repeat(64)},{...request,sessionLink:null},{...request,owner:'other'},{...request,limit:101},{...request,offset:4001}])await assert.rejects(()=>f.client.linkedSession(bad));assert.equal(f.calls.length,0);
 for(const status of [404,503]){const old=client({error:{code:'UNAVAILABLE',message:'Unsupported operation',retryable:false}},status);await assert.rejects(()=>old.client.linkedSession(request));assert.equal(old.calls.length,1);assert.equal(old.calls[0].url,'/api/manual-plans/linkedSession');}
 const oversized=envelope();oversized.items[0].data.content='x'.repeat(256*1024);const large=client(oversized);await assert.rejects(()=>large.client.linkedSession(request));assert.equal(large.calls.length,1);
});
test('host generation invalidation rejects a delayed valid page',async()=>{
 let active=true,release;const gate=new Promise(resolve=>release=resolve),calls=[];
 const f=new ManualPlanClient(async(url)=>{calls.push(url);await gate;return new Response(JSON.stringify(envelope()),{headers:{'content-type':'application/json'}});},()=>{if(!active)throw Error('host changed');});
 const read=f.linkedSession(request);active=false;release();await assert.rejects(read,/host changed/);assert.deepEqual(calls,['/api/manual-plans/linkedSession']);
});
