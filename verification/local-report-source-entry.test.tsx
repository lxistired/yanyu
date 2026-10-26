import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceReportsEntry } from '../candidate/src/components/ServiceReportsEntry';
const scope='a'.repeat(64), store='11111111-1111-4111-8111-111111111111';
const item=(n:number)=>({documentId:`local-doc:${store}:22222222-2222-4222-8222-${String(n).padStart(12,'0')}`,revisionId:`content:${'b'.repeat(64)}:${'c'.repeat(64)}`,name:`Synthetic local fixture ${n}`,format:'txt',metadataRevision:0});
const page=(items:unknown[],nextOffset:number|null=null)=>({scope,capabilities:{localDocuments:true,syntheticFixture:true},storeScope:store,items,nextOffset});
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const props={available:true,visible:true,identityScope:'e'.repeat(64),routeEpoch:1};
function setup(reply:(body:any)=>Promise<Response>|Response){
 window.localStorage.clear();
 const fetch=vi.fn(async(url:unknown,init?:RequestInit)=>{
  const route=String(url).split('/').pop();
  if(route==='scope')return json({scope});
  if(route==='sourceChoices')return reply(JSON.parse(String(init?.body)));
  if(route==='listReports')return json({scope,items:[],nextAfter:null,censusSha256:'d'.repeat(64)});
  if(route==='customers')return json({scope,items:[],nextAfter:null,censusSha256:'d'.repeat(64)});
  throw new Error(`Unexpected route ${route}`);
 });vi.stubGlobal('fetch',fetch);return fetch;
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();window.localStorage.clear()});
it('shows new-upload revision-zero options and explicit next/reset pagination, never implicitly selects a source',async()=>{
 const fetch=setup(body=>json(body.offset===0?page(Array.from({length:25},(_,i)=>item(i+1)),25):page([item(26)])));
 const user=userEvent.setup();render(<ServiceReportsEntry {...props}/>);
 await screen.findByRole('option',{name:/Synthetic local fixture 1 ·/});
 expect((screen.getByLabelText('已上传资料') as HTMLSelectElement).value).toBe('');
 await user.click(screen.getByRole('button',{name:'下一页本地资料'}));
 await screen.findByRole('option',{name:/Synthetic local fixture 26 ·/});
 expect(screen.queryByRole('option',{name:/Synthetic local fixture 1 ·/})).toBeNull();
 expect(fetch.mock.calls.some(([,init])=>String(init?.body)===JSON.stringify({offset:25,limit:25,storeScope:store}))).toBe(true);
 await user.click(screen.getByRole('button',{name:'从第一页刷新资料库选项'}));
 await screen.findByRole('option',{name:/Synthetic local fixture 1 ·/});
 expect(fetch.mock.calls.every(([url])=>!String(url).includes('/api/files'))).toBe(true);
});
it('distinguishes unconfigured local capability from configured empty library',async()=>{
 setup(()=>json({scope,capabilities:{localDocuments:false,syntheticFixture:true},storeScope:null,items:[],nextOffset:null}));
 const view=render(<ServiceReportsEntry {...props}/>);
 await screen.findByText(/当前服务未配置本地资料来源/);
 expect(screen.queryByText('本页没有可选的当前本地资料')).toBeNull();view.unmount();
 setup(()=>json(page([])));render(<ServiceReportsEntry {...props}/>);await screen.findByText('本页没有可选的当前本地资料');
});
it('rejects mixed-store rows rather than displaying a partial page or substituting synthetic',async()=>{
 setup(()=>json(page([item(1),{...item(2),documentId:'local-doc:33333333-3333-4333-8333-333333333333:22222222-2222-4222-8222-222222222222'}])));
 render(<ServiceReportsEntry {...props}/>);await screen.findByText('资料库选项无法完整校验，请刷新后重试');
 expect(screen.queryByRole('option',{name:/Synthetic local fixture/})).toBeNull();
 expect((screen.getByLabelText('已上传资料') as HTMLSelectElement).value).toBe('');
});
it('late list after route dismissal cannot display source options',async()=>{
 let finish!:(v:Response)=>void;const fetch=setup(()=>new Promise(resolve=>{finish=resolve}));
 const view=render(<ServiceReportsEntry {...props}/>);
 await waitFor(()=>expect(fetch.mock.calls.some(([u])=>String(u).endsWith('/sourceChoices'))).toBe(true));
 view.rerender(<ServiceReportsEntry {...props} visible={false}/>);
 await act(async()=>finish(json(page([item(1)]))));
 expect(screen.queryByRole('option',{name:/Synthetic local fixture/})).toBeNull();
});

import { ServiceReportsWorkspace } from '../candidate/src/components/ServiceReportsWorkspace';
import { createServiceReportsClient, createServiceReportsCommands } from '../candidate/src/adapters/service-reports';
it('withdraws stale revision-zero upload inspection and displays successful zero-revision source verification',async()=>{
 window.localStorage.clear();const actor={binding:props.identityScope,epoch:1};let finish!:(value:Response)=>void;
 const fetch=vi.fn(async(url:unknown)=>{
  if(String(url).endsWith('/scope'))return json({scope});
  if(String(url).endsWith('/inspectSource'))return new Promise<Response>(resolve=>{finish=resolve});
  return json({scope,items:[],nextAfter:null,censusSha256:'d'.repeat(64)});
 });
 const client=createServiceReportsClient({fetch:fetch as typeof globalThis.fetch,getActor:()=>actor});
 const commands=createServiceReportsCommands(client,{storage:window.localStorage});
 const first=item(1), selected={documentId:first.documentId,revisionId:first.revisionId,name:first.name};
 const common={client,commands,actor,status:'available' as const,routeEpoch:1,initialSelection:{customer:null,month:'2026-10',timeZone:'UTC',includeArchived:false},librarySourceBinding:{actor,scope,routeEpoch:1},onOpenSource:vi.fn(),onWithdrawSource:vi.fn(),onDownload:vi.fn()};
 const view=render(<ServiceReportsWorkspace {...common} librarySourceChoices={{state:'ready',value:[selected]}}/>);
 const user=userEvent.setup();await screen.findByRole('option',{name:/Synthetic local fixture 1 ·/});
 await user.selectOptions(screen.getByLabelText('已上传资料'),JSON.stringify([selected.documentId,selected.revisionId]));
 await user.click(screen.getByRole('button',{name:'核验所选资料'}));
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 view.rerender(<ServiceReportsWorkspace {...common} librarySourceChoices={{state:'ready',value:[]}}/>);
 const pin={documentId:selected.documentId,revisionId:selected.revisionId,tenantId:'tenant',collectionId:'collection',sha256:'f'.repeat(64)};
 await act(async()=>finish(json({scope,pin,sourceKind:'local-document',locator:{storeScope:store,documentId:'22222222-2222-4222-8222-000000000001',metadataRevision:0}})));
 await screen.findByText('资料页已改变，请重新选择并核验精确来源');expect(common.onOpenSource).not.toHaveBeenCalled();
 view.rerender(<ServiceReportsWorkspace {...common} librarySourceChoices={{state:'ready',value:[selected]}}/>);
 await user.click(screen.getByRole('button',{name:'核验所选资料'}));
 await act(async()=>finish(json({scope,pin,sourceKind:'local-document',locator:{storeScope:store,documentId:'22222222-2222-4222-8222-000000000001',metadataRevision:0}})));
 await within(screen.getByLabelText('精确来源核验状态')).findByText('已核验 1 个精确来源；记录活动时仍需明确勾选。');
 await user.click(screen.getByRole('button',{name:'核验所选资料'}));
 await act(async()=>finish(json({scope,pin})));
 await within(screen.getByLabelText('精确来源核验状态')).findByRole('alert');
 expect(screen.queryByText('已核验 1 个精确来源；记录活动时仍需明确勾选。')).toBeNull();
 view.unmount();commands.dispose();client.withdraw();
});
