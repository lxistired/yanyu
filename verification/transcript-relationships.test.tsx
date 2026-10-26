import {fixtureStoreHeaders, fixtureStoreUrl} from './transcription-store-fixture';
import {TranscriptionStoreBoundary} from '../candidate/src/components/TranscriptionStoreBoundary';
import {beforeEach,afterEach, it, expect, vi} from 'vitest';
import {render, screen, fireEvent, waitFor, cleanup} from '@testing-library/react';
import {TranscriptRelationshipEditor, RelatedTranscriptLinks} from '../candidate/src/components/TranscriptRelationships';
import {LocalTranscription} from '../candidate/src/components/LocalTranscription';
const catalog = {workspaces: [{id:'a',name:'Alpha',count:2},{id:'b',name:'Beta',count:1}],sessions:[{id:'s1',workspaceId:'a',title:'Session A',count:2},{id:'s2',workspaceId:'b',title:'Session B',count:1}]};
const receipt = (options?:RequestInit) => {const {workspaceId,sessionId,expectedRevision}=JSON.parse(options?.body as string);return {relationship:{workspaceId,sessionId,revision:expectedRevision+1,workspaceName:null,sessionTitle:null,stale:false}};};
const ok = (data:unknown) => ({headers:fixtureStoreHeaders(),ok:true,status:200,json:async()=>data});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');});
it('limits sessions to the selected workspace and clears session on workspace change',async()=>{
 const f=vi.fn(async(url:string, options?:RequestInit)=>ok(url.endsWith('/relationships') ? catalog : receipt(options)));vi.stubGlobal('fetch',f);
 render(<TranscriptionStoreBoundary><TranscriptRelationshipEditor id="job" relationship={null} onChanged={()=>{}}/></TranscriptionStoreBoundary>);
 fireEvent.click(screen.getByText('关联工作区 / 会话'));
 const workspace=await screen.findByLabelText('关联工作区');fireEvent.change(workspace,{target:{value:'a'}});
 fireEvent.change(screen.getByLabelText('关联会话'),{target:{value:'s1'}});
 expect(screen.queryByRole('option',{name:'Session B'})).toBeNull();
 fireEvent.change(workspace,{target:{value:'b'}});expect((screen.getByLabelText('关联会话') as HTMLSelectElement).value).toBe('');
 fireEvent.click(screen.getByText('保存关联'));
 await waitFor(()=>expect(f.mock.calls.some(([url])=>url.endsWith('/relationship'))).toBe(true));
 const body=JSON.parse(f.mock.calls.find(([url])=>url.endsWith('/relationship'))![1]?.body as string);
 expect(body).toMatchObject({workspaceId:'b',sessionId:null,expectedRevision:0});expect(body.idempotencyKey).toMatch(/^[\da-f-]{36}$/);
});
it('blocks conflicts until explicit fresh reload and clears using latest revision',async()=>{
 vi.spyOn(window,'confirm').mockReturnValue(true);
 let reject=true;
 const f=vi.fn(async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/relationships'))return ok(catalog);
  if(url.includes('/jobs?'))return ok({jobs:[{id:'job',status:'completed',relationship:{workspaceId:'b',sessionId:'s2',revision:5,workspaceName:'Beta',sessionTitle:'Session B',stale:false}}]});
  if(reject){reject=false;return {headers:fixtureStoreHeaders(),ok:false,status:409,json:async()=>({error:{message:'Conflict'}})};}return ok(receipt(options));
 });vi.stubGlobal('fetch',f);
 render(<TranscriptionStoreBoundary><TranscriptRelationshipEditor id="job" relationship={{workspaceId:'a',sessionId:'s1',revision:4,stale:false}} onChanged={()=>{}}/></TranscriptionStoreBoundary>);
 fireEvent.click(screen.getByText('关联工作区 / 会话'));fireEvent.click(await screen.findByText('保存关联'));await screen.findByText('Conflict');
 expect((screen.getByText('保存关联') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByText('重新载入关联'));await waitFor(()=>expect((screen.getByLabelText('关联工作区') as HTMLSelectElement).value).toBe('b'));
 fireEvent.click(screen.getByText('清除关联'));await waitFor(()=>expect(f.mock.calls.filter(([url])=>url.endsWith('/relationship'))).toHaveLength(2));
 expect(JSON.parse(f.mock.calls.filter(([url])=>url.endsWith('/relationship'))[1][1]?.body as string)).toMatchObject({workspaceId:null,sessionId:null,expectedRevision:5});
});
it('shows stale relationships without pretending they are usable and offers clear',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>ok(catalog)));
 render(<TranscriptionStoreBoundary><TranscriptRelationshipEditor id="job" relationship={{workspaceId:'gone',sessionId:'gone-session',revision:3,stale:true}} onChanged={()=>{}}/></TranscriptionStoreBoundary>);
 expect(screen.getByText(/关联已失效/)).toBeTruthy();expect(screen.queryByText('查看此工作区的转写')).toBeNull();
 fireEvent.click(screen.getByText('关联工作区 / 会话'));await screen.findByText('清除关联');expect((screen.getByText('保存关联') as HTMLButtonElement).disabled).toBe(true);expect((screen.getByText('清除关联') as HTMLButtonElement).disabled).toBe(false);
});
it('links workspace and session counts to filtered library',async()=>{
 const f=vi.fn(async(url:string)=>ok(url==='/api/local-asr/identity'?{transcriptionStoreId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}:catalog));vi.stubGlobal('fetch',f);render(<RelatedTranscriptLinks workspaceId="a"/>);
 expect((await screen.findByText('Alpha · 2 条转写')).getAttribute('href')).toBe('/?page=files&transcriptStoreId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&workspaceId=a');
 expect(screen.getByText('Session A · 2 条转写').getAttribute('href')).toBe('/?page=files&transcriptStoreId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&workspaceId=a&sessionId=s1');expect(screen.queryByText(/Beta/)).toBeNull();expect(f.mock.calls.map(([url])=>url)).toEqual(['/api/local-asr/identity','/api/local-asr/relationships']);
});
it('loads an exact transcript URL with jobId and supports clearing filters',async()=>{
 history.replaceState(null,'',fixtureStoreUrl('/?page=files&transcriptJob=exact'));
 const f=vi.fn(async(_url:string)=>ok({jobs:[],model:null,total:0}));vi.stubGlobal('fetch',f);render(<LocalTranscription/>);
 await waitFor(()=>expect(f.mock.calls[0][0]).toContain('jobId=exact'));
 fireEvent.click(screen.getByText('显示全部关联范围'));await waitFor(()=>expect(f.mock.calls.length).toBeGreaterThan(1));expect(location.search).toBe(new URL(fixtureStoreUrl('/?page=files'),'http://localhost').search);
});

beforeEach(() => { history.replaceState(null, '', fixtureStoreUrl()); });

it('preserves prefixed domain IDs through choices, save and scoped count URLs',async()=>{
 const prefixed={workspaces:[{id:'_workspace',name:'Prefixed',count:1}],sessions:[{id:'-session',workspaceId:'_workspace',title:'Prefixed session',count:1}]};
 const f=vi.fn(async(url:string,options?:RequestInit)=>ok(url==='/api/local-asr/identity'?{transcriptionStoreId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}:url.endsWith('/relationships')?prefixed:receipt(options)));vi.stubGlobal('fetch',f);
 render(<TranscriptionStoreBoundary><TranscriptRelationshipEditor id="job" relationship={null} onChanged={()=>{}}/></TranscriptionStoreBoundary>);
 fireEvent.click(screen.getByText('关联工作区 / 会话'));fireEvent.change(await screen.findByLabelText('关联工作区'),{target:{value:'_workspace'}});fireEvent.change(screen.getByLabelText('关联会话'),{target:{value:'-session'}});fireEvent.click(screen.getByText('保存关联'));
 await waitFor(()=>expect(f.mock.calls.some(([url])=>url.endsWith('/relationship'))).toBe(true));
 expect(JSON.parse(f.mock.calls.find(([url])=>url.endsWith('/relationship'))![1]?.body as string)).toMatchObject({workspaceId:'_workspace',sessionId:'-session'});
 cleanup();render(<RelatedTranscriptLinks workspaceId="_workspace"/>);
 const link=await screen.findByText('Prefixed session · 1 条转写');const params=new URL(link.getAttribute('href')!,'http://localhost').searchParams;
 expect(params.get('workspaceId')).toBe('_workspace');expect(params.get('sessionId')).toBe('-session');expect(params.get('transcriptStoreId')).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});
