import {researchTranscriptDestination} from '../candidate/src/components/ordinary-navigation';
import React, {StrictMode} from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor,act,within} from '@testing-library/react';
import {ExternalTranscriptionSource} from '../candidate/src/components/external-transcription-source';
import {ResearchRequestOwner,transcriptPage} from '../candidate/src/components/local-research-search';
import {LocalResearchSearch} from '../candidate/src/components/LocalResearchSearch';
import {LocalRecentMaterials} from '../candidate/src/components/LocalRecentMaterials';
import {RelatedTranscriptLinks} from '../candidate/src/components/TranscriptRelationships';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id='11111111-1111-4111-8111-111111111111';
const reply=(data:unknown,scope:string|null=A,status=200)=>({ok:status===200,status,headers:new Headers(scope===null?{}:{'X-Transcription-Store-Id':scope}),json:vi.fn(async()=>data)}) as unknown as Response;
const jobs=(offset=0,total=1)=>({offset,total,limit:10,hasMore:offset+10<total,jobs:Array.from({length:Math.min(10,Math.max(0,total-offset))},(_,i)=>({id:`11111111-1111-4111-8111-${String(offset+i+1).padStart(12,'0')}`,title:`Job ${offset+i+1}`,filename:'synthetic.wav',status:'completed',created:'2026-01-01',deleted_at:null,result:null}))});
const identity=(scope=A)=>reply({transcriptionStoreId:scope},scope);
const catalog={workspaces:[{id:'w',name:'Workspace',count:2}],sessions:[{id:'s',workspaceId:'w',title:'Session',count:1}]};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('captures canonical header and projects mandatory DTO provenance; retries remain bound',async()=>{
 const f=vi.fn(async(_input:string,_init?:RequestInit)=>_input==='/api/local-asr/identity'?identity():reply(jobs()));vi.stubGlobal('fetch',f);const source=new ExternalTranscriptionSource(),owner=new ResearchRequestOwner();
 const result=await source.read('/api/local-asr/jobs?limit=10',owner.begin());expect(transcriptPage(result.data,0,result.transcriptStoreId).items[0].transcriptStoreId).toBe(A);
 await source.read('/api/local-asr/jobs?q=next',owner.begin());expect(f.mock.calls[0][0]).toBe('/api/local-asr/identity');expect(new Headers(f.mock.calls[0]?.[1]?.headers).has('X-Transcription-Store-Id')).toBe(false);for(const call of f.mock.calls.slice(1)){expect(new Headers(call[1]?.headers).get('X-Transcription-Store-Id')).toBe(A);}expect(f.mock.calls[2][0]).toBe('/api/local-asr/jobs?q=next');
 expect(()=>transcriptPage(jobs(),0,'bad')).toThrow();
});
it.each([B,null,'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',A+','+A])('rejects changed or invalid response %s before body and blocks retry',async scope=>{
 const bad=reply({secret:'must not consume'},scope);const f=vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(reply(jobs())).mockResolvedValue(bad);vi.stubGlobal('fetch',f);const source=new ExternalTranscriptionSource(),owner=new ResearchRequestOwner();
 await source.read('/api/local-asr/jobs?',owner.begin());await expect(source.read('/api/local-asr/jobs?',owner.begin())).rejects.toThrow();expect(bad.json).not.toHaveBeenCalled();await expect(source.read('/api/local-asr/jobs?',owner.begin())).rejects.toThrow();expect(f).toHaveBeenCalledTimes(3);
});
it('stale initial headers cannot capture and stale JSON cannot commit',async()=>{
 let release!:(value:Response)=>void;const f=vi.fn().mockImplementationOnce(()=>new Promise(r=>release=r)).mockImplementation(async(input:string)=>input==='/api/local-asr/identity'?identity(B):reply({},B));vi.stubGlobal('fetch',f);const source=new ExternalTranscriptionSource(),owner=new ResearchRequestOwner();
 const old=source.read('/api/local-asr/jobs?',owner.begin());const rejection=expect(old).rejects.toMatchObject({name:'AbortError'});await source.read('/api/local-asr/jobs?',owner.begin());release(reply({},A));await rejection;source.assertActive(B);
 let decode!:(value:unknown)=>void;const response=reply({},B);response.json=()=>new Promise(r=>decode=r);f.mockResolvedValueOnce(response);const late=source.read('/api/local-asr/jobs?',owner.begin());await waitFor(()=>expect(decode).toBeTruthy());owner.cancel();decode({});await expect(late).rejects.toMatchObject({name:'AbortError'});
});
it('body identity conflicts stop; HTTP failure retries cannot change source',async()=>{
 const source=new ExternalTranscriptionSource(),owner=new ResearchRequestOwner();const f=vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(reply({},A,503)).mockResolvedValueOnce(reply({},B));vi.stubGlobal('fetch',f);await expect(source.read('/api/local-asr/jobs?',owner.begin())).rejects.toThrow('503');await expect(source.read('/api/local-asr/jobs?',owner.begin())).rejects.toThrow();
 const other=new ExternalTranscriptionSource();f.mockResolvedValueOnce(identity()).mockResolvedValue(reply({transcriptionStoreId:B},A));await expect(other.read('/api/local-asr/jobs?',owner.begin())).rejects.toThrow();expect(other.blocked).toBe(true);
});
function sources(scope:()=>string, total=11) {
 const f=vi.fn(async(input:string,init?:RequestInit)=>{const url=new URL(input,'http://localhost');if(input==='/api/local-asr/identity')return identity(scope());if(url.pathname==='/api/documents/choices')return reply({uploadScope:A});if(url.pathname==='/api/documents')return reply({storeScope:A,documents:[],total:0,offset:0,limit:10});if(url.pathname==='/api/local-asr/relationships')return reply(catalog,scope());return reply(jobs(Number(url.searchParams.get('offset')||0),total),scope());});vi.stubGlobal('fetch',f);return f;
}
it('search pins page/query/refresh/tab return and generated links, requires explicit reload after mismatch',async()=>{
 let scope=A;const f=sources(()=>scope),navigate=vi.fn();render(<LocalResearchSearch onNavigate={navigate}/>);fireEvent.click(screen.getByRole('button',{name:'转写',exact:true}));await screen.findByText('Job 1');
 fireEvent.click(within(screen.getByRole('region',{name:'本地转写搜索'})).getByText('下一页'));await screen.findByText('Job 11');fireEvent.change(screen.getByLabelText('转写查询'),{target:{value:'different'}});fireEvent.click(screen.getByText('搜索转写'));await screen.findByText('Job 1');
 fireEvent.click(screen.getAllByText('在转写资料库打开')[0]);expect(new URL(navigate.mock.calls[0][0],'http://localhost').searchParams.get('transcriptStoreId')).toBe(A);
 fireEvent.click(screen.getByRole('button',{name:'文档',exact:true}));fireEvent.click(screen.getByRole('button',{name:'转写',exact:true}));await screen.findByText('Job 1');
 const calls=f.mock.calls.filter(([u])=>u.startsWith('/api/local-asr/jobs'));expect(calls.length).toBeGreaterThan(2);for(const [,init]of calls)expect(new Headers(init?.headers).get('X-Transcription-Store-Id')).toBe(A);
 scope=B;fireEvent.click(screen.getByText('刷新转写结果'));await screen.findByText(/已停止此页请求/);expect(screen.queryByText('Job 1')).toBeNull();const count=f.mock.calls.length;fireEvent.click(screen.getByText('搜索转写'));await act(async()=>{});expect(f.mock.calls.length).toBe(count);
 fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('Job 1');expect(screen.getAllByText('在转写资料库打开')[0].getAttribute('href')).toContain(B);
});
it('recent materials holds source across pagination, blocks substitution and keeps documents separate',async()=>{
 let scope=A;const f=sources(()=>scope);render(<StrictMode><LocalRecentMaterials/></StrictMode>);await screen.findByText('Job 1');fireEvent.click(within(screen.getByRole('navigation',{name:'转写记录分页'})).getByText('下一页'));await screen.findByText('Job 11');scope=B;fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText(/已停止此页请求/);expect(screen.queryByText('Job 11')).toBeNull();expect(screen.getByText('暂无未删除的本地文档。')).toBeTruthy();fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('Job 1');expect(f.mock.calls.some(([,init])=>new Headers(init?.headers).get('X-Transcription-Store-Id')===A)).toBe(true);
});
it('relationship count and links hold scope through prop change and refresh, then explicit reload',async()=>{
 let scope=A;const f=sources(()=>scope);const view=render(<RelatedTranscriptLinks workspaceId="w"/>);expect((await screen.findByText('Workspace · 2 条转写')).getAttribute('href')).toContain(A);view.rerender(<RelatedTranscriptLinks workspaceId="w" sessionId="s"/>);await screen.findByText('Session · 1 条转写');expect(new Headers(f.mock.calls.at(-1)?.[1]?.headers).get('X-Transcription-Store-Id')).toBe(A);scope=B;fireEvent.click(screen.getByText('刷新关联计数'));await screen.findByText(/已停止此页请求/);expect(screen.queryByRole('link')).toBeNull();fireEvent.click(screen.getByText('重新载入关联转写来源'));expect((await screen.findByText('Workspace · 2 条转写')).getAttribute('href')).toContain(B);
});
it('invalid count DTO never becomes a usable link',async()=>{vi.stubGlobal('fetch',vi.fn(async(input:string)=>input==='/api/local-asr/identity'?identity():reply({workspaces:[{id:'w',name:'W',count:-1}],sessions:[]})));render(<RelatedTranscriptLinks/>);await screen.findByText('关联转写计数响应无效');expect(screen.queryByRole('link')).toBeNull();});
it('another owned request stops pending body consumption on mismatch',async()=>{
 let decode!:(value:unknown)=>void;const pending=reply({},A);pending.json=()=>new Promise(r=>decode=r);const f=vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(pending).mockResolvedValueOnce(reply({},B));vi.stubGlobal('fetch',f);const source=new ExternalTranscriptionSource(),first=new ResearchRequestOwner(),second=new ResearchRequestOwner();const old=source.read('/api/local-asr/jobs?',first.begin());await waitFor(()=>expect(decode).toBeTruthy());await expect(source.read('/api/local-asr/jobs?',second.begin())).rejects.toThrow();decode({});await expect(old).rejects.toThrow();
});
it('double explicit reload cannot admit first late discovery',async()=>{
 let release!:(value:Response)=>void;let count=0;vi.stubGlobal('fetch',vi.fn(async(input:string)=>{if(input.startsWith('/api/documents/choices'))return reply({uploadScope:A});if(input.startsWith('/api/documents?'))return reply({storeScope:A,documents:[],total:0,offset:0,limit:10});count++;if(count===1)return new Promise<Response>(r=>release=r);return input==='/api/local-asr/identity'?identity(B):reply(jobs(),B);}));render(<LocalRecentMaterials onNavigate={()=>{}}/>);await waitFor(()=>expect(release).toBeTruthy());fireEvent.click(screen.getByText('重新载入转写来源'));fireEvent.click(screen.getByText('重新载入转写来源'));await screen.findByText('Job 1');await act(async()=>release(reply(jobs(),A)));fireEvent.click(screen.getByText('刷新转写记录'));await screen.findByText('Job 1');expect(screen.queryByText(/已停止此页请求/)).toBeNull();
});
it('initial missing header fails closed without consuming discovery body',async()=>{const response=reply({},null);vi.stubGlobal('fetch',vi.fn(async()=>response));const source=new ExternalTranscriptionSource();await expect(source.read('/api/local-asr/jobs?',new ResearchRequestOwner().begin())).rejects.toThrow();expect(response.json).not.toHaveBeenCalled();expect(source.blocked).toBe(true);});

it('guarded research navigation admits only canonical scoped exact-job destinations',()=>{
 const base='https://local.test/?page=research';const good=`/?page=files&transcriptJob=${id}&transcriptStoreId=${A}`;expect(researchTranscriptDestination(good,base)?.searchParams.get('transcriptStoreId')).toBe(A);
 for(const bad of [`/?page=files&transcriptJob=${id}`,good+'&transcriptStoreId='+A,good+'&extra=1',good.replace(A,'bad'),good.replace(A,A.toUpperCase()),good+'#fragment','https://other.test'+good,good+'&transcriptJob='+id])expect(researchTranscriptDestination(bad,base)).toBeNull();
});

it('identity-to-record service change is rejected before consuming any job data',async()=>{
 const bad=reply(jobs(),B);const f=vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(bad);vi.stubGlobal('fetch',f);const source=new ExternalTranscriptionSource();
 await expect(source.read('/api/local-asr/jobs?',new ResearchRequestOwner().begin())).rejects.toThrow();expect(bad.json).not.toHaveBeenCalled();expect(source.blocked).toBe(true);
 expect(f.mock.calls[0][0]).toBe('/api/local-asr/identity');expect(new Headers(f.mock.calls[1][1].headers).get('X-Transcription-Store-Id')).toBe(A);
});
it.each([{},null,{transcriptionStoreId:B}])('invalid identity body never opens record route: %j',async data=>{
 const f=vi.fn(async()=>reply(data));vi.stubGlobal('fetch',f);const source=new ExternalTranscriptionSource();await expect(source.read('/api/local-asr/jobs?',new ResearchRequestOwner().begin())).rejects.toThrow();expect(source.blocked).toBe(true);expect(f).toHaveBeenCalledOnce();
});

it('stale identity JSON cannot bind after a newer discovery owns the source',async()=>{
 let release!:(value:unknown)=>void;const oldIdentity=identity();oldIdentity.json=()=>new Promise(resolve=>release=resolve);
 const f=vi.fn().mockResolvedValueOnce(oldIdentity).mockResolvedValueOnce(identity(B)).mockResolvedValue(reply(jobs(),B));vi.stubGlobal('fetch',f);
 const source=new ExternalTranscriptionSource(),owner=new ResearchRequestOwner();const old=source.read('/api/local-asr/jobs?',owner.begin());const rejected=expect(old).rejects.toMatchObject({name:'AbortError'});
 await waitFor(()=>expect(release).toBeTruthy());await source.read('/api/local-asr/jobs?',owner.begin());release({transcriptionStoreId:A});await rejected;source.assertActive(B);
 expect(f).toHaveBeenCalledTimes(3);expect(new Headers(f.mock.calls[2][1].headers).get('X-Transcription-Store-Id')).toBe(B);
});
