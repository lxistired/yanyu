import './agenda-loader.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {agendaInstant,agendaRequest,validateAgendaPage,formatAgendaInstant}=await import('../candidate/src/components/local-meeting-agenda.ts');
const filters={from:'',to:'',state:''};
const request=agendaRequest(filters);
const row=(id='a',patch={})=>({id,kind:'meeting',revision:1,createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',deletedAt:null,data:{title:'<img src=x onerror=evil()>',organizationId:null,series:'',category:'research',startsAt:'2026-10-21T00:00:00.000Z',endsAt:'2026-10-21T01:00:00.000Z',timezone:'Asia/Shanghai',location:'Room A',description:'',attendeeIds:[],state:'scheduled',providerAvailability:'unconfigured',...patch}});
const page=items=>({items,total:items.length,offset:0,nextOffset:null});
test('strict bounded records, envelope, filters and unsafe payload rejection',()=>{
 assert.equal(validateAgendaPage(page([row()]),request).items.length,1);
 for(const state of ['scheduled','completed','cancelled'])validateAgendaPage(page([row('a',{state})]),request);
 const bad=[r=>r.kind='session',r=>r.deletedAt='2026-01-01T00:00:00Z',r=>r.revision=Infinity,r=>r.id='../x',r=>delete r.data.state,r=>r.data.state='future',r=>r.data.timezone='+08:00',r=>r.data.timezone='Not/AZone',r=>r.data.startsAt='2026-02-30T00:00:00Z',r=>r.data.endsAt=r.data.startsAt,r=>r.data.title='x'.repeat(721),r=>r.data.attendeeIds=['a','a'],r=>r.data.owner='x',r=>r.data.providerAvailability='connected',r=>r.createdAt='no',r=>r.data.description='\x00'];
 for(const mutate of bad){const r=row();mutate(r);assert.throws(()=>validateAgendaPage(page([r]),request));}
 for(const p of [{...page([]),total:1},{...page([row()]),nextOffset:0},{...page([row()]),total:NaN},{...page([]),owner:'x'},page([row(),row()]),page(Array.from({length:51},(_,i)=>row(String(i))))])assert.throws(()=>validateAgendaPage(p,request));
 validateAgendaPage({items:[],offset:50,total:2,nextOffset:null},{...request,offset:50});
 assert.throws(()=>agendaRequest({...filters,from:'2026-10-21T00:00'}));
 assert.throws(()=>agendaRequest({...filters,from:'2026-10-21T00:00:00+08:00'}));
 assert.throws(()=>agendaRequest({...filters,from:'2026-10-22T00:00:00Z',to:'2026-10-21T00:00:00Z'}));
 assert.throws(()=>validateAgendaPage(page([row()]),agendaRequest({...filters,state:'completed'})));
 assert.throws(()=>validateAgendaPage(page([row()]),agendaRequest({...filters,to:'2026-10-21T00:00:00Z'})));
});
test('explicit UTC/offset dates, named zones near midnight and DST are not browser local',()=>{
 assert.equal(agendaInstant('2026-10-21T08:00:00+08:00'),'2026-10-21T00:00:00.000Z');
 assert.equal(agendaInstant('2026-10-20T17:00:00-07:00'),'2026-10-21T00:00:00.000Z');
 for(const bad of ['2026-02-29T00:00:00Z','2026-10-21T25:00:00Z','2026-10-21T00:00:00+14:01','1969-12-31T23:59:59Z'])assert.throws(()=>agendaInstant(bad));
 assert.match(formatAgendaInstant('2026-10-21T00:00:00Z','Asia/Shanghai'),/08:00:00/);
 assert.match(formatAgendaInstant('2026-10-21T00:00:00Z','America/Los_Angeles'),/2026\/10\/20/);
 assert.match(formatAgendaInstant('2026-03-08T06:59:00Z','America/New_York'),/01:59:00/);
 assert.match(formatAgendaInstant('2026-03-08T07:00:00Z','America/New_York'),/03:00:00/);
 assert.equal(formatAgendaInstant('bad','bad'),'时间无法显示');
});
test('production OrganizationDomain and temporary synthetic store: sort/range/trash/state/retry/revision/owner/reopen/page bytes',async()=>{
 const {DomainStore}=await import('../backend/source/server/workspace-store.ts');
 const {OrganizationDomain}=await import('../backend/source/server/organization-domain.ts');
 const root=mkdtempSync(join(tmpdir(),'agenda-synthetic-'));let store=new DomainStore(root),domain=new OrganizationDomain(store);
 const context=owner=>({principal:{tenantId:'synthetic-agenda',subjectId:owner,collectionIds:['synthetic']},signal:new AbortController().signal,requestId:'agenda-test'});
 const a=context('a'),b=context('b'); let seq=0;
 const create=(id,data={},ctx=a)=>domain.create(ctx,{kind:'meeting',id,data:{title:id,startsAt:'2026-10-21T00:00:00Z',endsAt:'2026-10-21T01:00:00Z',timezone:'Asia/Shanghai',...data},idempotencyKey:'create-'+id});
 try{
  const first=create('b');assert.deepEqual(create('b'),first);create('a');create('overlap',{startsAt:'2026-10-20T23:00:00Z'});create('end',{startsAt:'2026-10-22T00:00:00Z',endsAt:'2026-10-22T01:00:00Z'});create('private',{},b);
  assert.deepEqual(domain.list(a,request).items.map(r=>r.id),['overlap','a','b','end']);
  const bounded=agendaRequest({...filters,from:'2026-10-21T00:00:00Z',to:'2026-10-22T00:00:00Z'});
  assert.deepEqual(validateAgendaPage(domain.list(a,bounded),bounded).items.map(r=>r.id),['a','b']);
  assert.equal(domain.list(b,request).total,1);
  const cancelled=domain.update(a,{kind:'meeting',id:'b',expectedRevision:1,patch:{state:'cancelled'},idempotencyKey:'cancel'});
  assert.throws(()=>domain.update(a,{kind:'meeting',id:'b',expectedRevision:1,patch:{title:'stale'},idempotencyKey:'stale'}));
  assert.equal(domain.list(a,agendaRequest({...filters,state:'cancelled'})).total,1);
  const removed=domain.remove(a,{kind:'meeting',id:'b',expectedRevision:cancelled.revision,idempotencyKey:'delete'});
  assert.equal(domain.list(a,request).total,3);
  const restored=domain.restore(a,{kind:'meeting',id:'b',expectedRevision:removed.revision,idempotencyKey:'restore'});assert.equal(restored.data.state,'cancelled');
  assert.throws(()=>domain.list(a,{...request,owner:'b'}));
  assert.throws(()=>domain.list(a,{...request,unknown:true}));
  for(let i=0;i<40;i++)create('large_'+String(i).padStart(2,'0'),{description:'x'.repeat(16000)});
  let cursor=0,ids=[],short=false;
  do {const req=agendaRequest(filters,cursor);const p=validateAgendaPage(domain.list(a,req),req);ids.push(...p.items.map(r=>r.id));if(p.nextOffset!==null&&p.items.length<50)short=true;cursor=p.nextOffset;}while(cursor!==null);
  assert.equal(short,true);assert.equal(ids.length,44);assert.equal(new Set(ids).size,44);
  store.close();store=new DomainStore(root);domain=new OrganizationDomain(store);assert.equal(domain.list(a,request).total,44);
  assert.equal(validateAgendaPage(domain.list(a,{...request,offset:100}),{...request,offset:100}).items.length,0);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('source boundary: new view only lists; shell calendar mounted, planner unavailable and no session dates synthesized',()=>{
 const source=readFileSync(new URL('../candidate/src/components/LocalMeetingAgenda.tsx',import.meta.url),'utf8');
 assert.deepEqual([...source.matchAll(/organizationApi\.(\w+)/g)].map(m=>m[1]),['list']);
 assert.doesNotMatch(source,/setInterval|exportMeetingIcs|dangerouslySetInnerHTML|session\.createdAt|fetch\(/);
 const base=new URL('../../local-research-runtime-candidate-20261021/candidate/src/components/OrdinaryNavigationShell.tsx',import.meta.url);
 const shell=readFileSync(new URL('../candidate/src/components/OrdinaryNavigationShell.tsx',import.meta.url),'utf8'); assert.match(shell,/route.page==='calendar'/); assert.match(shell,/onManageOrganizations=\{\(\)=>navigate\('organization'\)\}/); assert.match(shell,/schedulerActive=\{false\} definitionsOnly/); const ordinary=shell.match(/const ordinaryPages[^;]+/)[0]; assert.doesNotMatch(ordinary,/'planner'/);
});
