// Synthetic React + jsdom + controlled fetch promises. No listener/browser/network.
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL){const u=new URL(s,c.parentURL);if(existsSync(fileURLToPath(u)+'.js'))return {url:u.href+'.js',shortCircuit:true};}return next(s,c);}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
for(const key of ['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent','Node','MutationObserver'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react');
const {render,fireEvent,cleanup,act}=await import('@testing-library/react');
const {LocalMeetingAgenda}=await import('../.agenda-build/src/components/LocalMeetingAgenda.js');
const row=(id='a',patch={})=>({id,kind:'meeting',revision:1,createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',deletedAt:null,data:{title:'Meeting '+id,organizationId:null,series:'',category:'research',startsAt:'2026-10-21T00:00:00.000Z',endsAt:'2026-10-21T01:00:00.000Z',timezone:'Asia/Shanghai',location:'Room A',description:'',attendeeIds:[],state:'scheduled',providerAvailability:'unconfigured',...patch}});
const response=(items=[],offset=0,total=items.length,nextOffset=null)=>({items,total,offset,nextOffset});
let calls=[];
globalThis.fetch=(url,init)=>new Promise((resolve,reject)=>calls.push({url,init,resolve,reject}));
const settle=async(call,value)=>act(async()=>{call.resolve(new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}}));await Promise.resolve();});
const fail=async call=>act(async()=>{call.reject(new Error('SECRET /private/token'));await Promise.resolve();});
function setup(){calls=[];return render(React.createElement(LocalMeetingAgenda,{onManageOrganizations:()=>calls.push({manage:true})}));}
test('loading, safe text, cancelled/completed, named-zone output, scope and generic manage callback',async()=>{
 const ui=setup();try{
  assert.match(ui.container.textContent,/正在读取/);assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/organization/list');assert.equal(calls[0].init.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body),{kind:'meeting',includeDeleted:false,sortBy:'date',direction:'asc',limit:50,offset:0});
  await settle(calls[0],response([row('a',{title:'<img src=x onerror=evil()>',state:'cancelled'}),row('b',{state:'completed'})]));
  assert.equal(ui.container.querySelectorAll('img').length,0);assert.match(ui.container.textContent,/<img src=x onerror=evil\(\)>/);assert.match(ui.container.textContent,/08:00:00/);assert.match(ui.container.textContent,/已取消/);assert.match(ui.container.textContent,/已完成/);assert.match(ui.container.textContent,/不是完整日历快照/);
  fireEvent.click(ui.getByText('在机构管理中管理会议'));assert.equal(calls.at(-1).manage,true);
 }finally{cleanup();}
});
test('filter changes abort prior request and fence ignored-abort late results; invalid filter never fetches',async()=>{
 const ui=setup();try{
  const old=calls[0];fireEvent.change(ui.getByLabelText('会议状态'),{target:{value:'completed'}});assert.equal(old.init.signal.aborted,true);assert.equal(calls.length,2);
  await settle(calls[1],response([row('new',{state:'completed'})]));await settle(old,response([row('stale')]));assert.match(ui.container.textContent,/Meeting new/);assert.doesNotMatch(ui.container.textContent,/Meeting stale/);
  fireEvent.change(ui.getByLabelText('UTC 下限'),{target:{value:'2026-02-30T00:00:00Z'}});assert.equal(calls.length,2);assert.match(ui.container.textContent,/筛选无效/);assert.doesNotMatch(ui.container.textContent,/Meeting new/);
  fireEvent.change(ui.getByLabelText('UTC 下限'),{target:{value:'2026-10-21T00:00:00Z'}});assert.equal(calls.length,3);assert.equal(JSON.parse(calls[2].init.body).from,'2026-10-21T00:00:00.000Z');
 }finally{cleanup();}
});
test('short byte-truncated pages follow actual nextOffset and bounded previous page stack; filters reset pagination',async()=>{
 const ui=setup();try{
  await settle(calls[0],response([row('a'),row('b')],0,5,2));fireEvent.click(ui.getByText('下一页'));assert.equal(JSON.parse(calls[1].init.body).offset,2);
  await settle(calls[1],response([row('c')],2,5,3));fireEvent.click(ui.getByText('下一页'));assert.equal(JSON.parse(calls[2].init.body).offset,3);
  await settle(calls[2],response([row('d'),row('e')],3,5));fireEvent.click(ui.getByText('上一页'));assert.equal(JSON.parse(calls[3].init.body).offset,2);
  await settle(calls[3],response([row('c')],2,5,3));fireEvent.change(ui.getByLabelText('会议状态'),{target:{value:'cancelled'}});assert.equal(JSON.parse(calls[4].init.body).offset,0);assert.equal(ui.getByText('上一页').disabled,true);
 }finally{cleanup();}
});
test('refresh error removes stale content, safe fixed error, explicit retry, distinct empty and unmount abort',async()=>{
 const ui=setup();try{
  await settle(calls[0],response([row('old')]));fireEvent.click(ui.getByText('刷新 / 重试'));assert.doesNotMatch(ui.container.textContent,/Meeting old/);await fail(calls[1]);assert.match(ui.container.textContent,/无法读取或校验/);assert.doesNotMatch(ui.container.textContent,/SECRET|没有符合/);
  fireEvent.click(ui.getByText('刷新 / 重试'));await settle(calls[2],response());assert.match(ui.container.textContent,/没有符合筛选/);
  fireEvent.click(ui.getByText('刷新 / 重试'));const pending=calls[3];ui.unmount();assert.equal(pending.init.signal.aborted,true);await settle(pending,response([row('late')]));assert.equal(document.body.textContent,'');
 }finally{cleanup();}
});
test('bad DTO is a read failure, never empty success; refresh abort/fence also handles reverse resolution',async()=>{
 const ui=setup();try{
  const first=calls[0];fireEvent.click(ui.getByText('刷新 / 重试'));assert.equal(first.init.signal.aborted,true);await settle(calls[1],response([row('valid')]));await fail(first);assert.match(ui.container.textContent,/Meeting valid/);
  fireEvent.click(ui.getByText('刷新 / 重试'));await settle(calls[2],response([row('bad',{timezone:'Not/AZone'})]));assert.match(ui.container.textContent,/无法读取或校验/);assert.doesNotMatch(ui.container.textContent,/Meeting bad|没有符合筛选/);
 }finally{cleanup();}
});
