// Real producer -> shell -> LocalDocuments admission. Only reader display and
// unrelated report leaf are mocked. In-memory DTO transport, not HTTP/browser.
import React,{useState,StrictMode} from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {useUnsavedWork} from '../candidate/src/components/unsaved-work';
vi.mock('../candidate/src/components/PdfPageReader',()=>({PdfPageReader:(p:any)=><div data-testid="converged-reader" data-id={p.documentId} data-sha={p.selectedSha256} data-scope={p.storeScope}/>}));
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const scope='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000002';
const document={id,name:'Synthetic convergence PDF',format:'pdf',revision:0,trashedAt:null,stale:false,sha256:'a'.repeat(64),pages:1,bytes:100,textSha256:'b'.repeat(64),createdAt:'2026-10-22T00:00:00Z',workspaceId:null,folderId:null,workspaceName:null,folderName:null};
function DirtyWitness(){const [value,set]=useState('');useUnsavedWork(!!value);return <input aria-label="synthetic unsaved witness" value={value} onChange={e=>set(e.target.value)}/>}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();history.replaceState(null,'','/');localStorage.clear()});
function transport(){const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=new URL(String(input),'http://localhost');let body:unknown;const headers:Record<string,string>={'Content-Type':'application/json'};
 if(url.pathname==='/api/documents/choices')body={uploadScope:scope,folders:[],workspaces:[]};
 else if(url.pathname==='/api/documents'){expect(new Headers(init?.headers).get('X-Document-Store-Id')).toBe(scope);body={storeScope:scope,documents:[document],total:1,offset:0,limit:10}}
 else if(url.pathname===`/api/documents/${id}`){expect(new Headers(init?.headers).get('X-Citation-Store-Id')).toBe(scope);expect(init?.signal).toBeDefined();body={storeScope:scope,document,text:'Synthetic extracted text'}}
 else if(url.pathname==='/api/local-asr/identity'){body={transcriptionStoreId:scope};headers['X-Transcription-Store-Id']=scope}
 else if(url.pathname==='/api/local-asr/jobs'){body={jobs:[],total:0,offset:0,limit:10,hasMore:false};headers['X-Transcription-Store-Id']=scope}
 else throw Error(`Unexpected synthetic request ${url.pathname}`);
 return new Response(JSON.stringify(body),{status:200,headers});});vi.stubGlobal('fetch',fetcher);return fetcher;}
for(const page of ['research','tasks'])it(`${page} real producer opens only after explicit click, accepted leave and receiver revalidation`,async()=>{
 history.replaceState(null,'',`/?page=${page}`);const fetcher=transport(),confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const lifetime=new OrdinaryRequestLifetime();render(<StrictMode><DirtyWitness/><OrdinaryNavigationShell lifetime={lifetime}/></StrictMode>);
 const button=await screen.findByRole('button',{name:'打开 PDF：Synthetic convergence PDF'});expect(screen.queryByTestId('converged-reader')).toBeNull();expect(fetcher.mock.calls.some(([u])=>new URL(String(u),'http://localhost').pathname===`/api/documents/${id}`)).toBe(false);
 const beforeStay=fetcher.mock.calls.length;fireEvent.change(screen.getByLabelText('synthetic unsaved witness'),{target:{value:'keep draft'}});fireEvent.click(button);expect(confirm).toHaveBeenCalledTimes(1);expect(location.search).toBe(`?page=${page}`);expect(lifetime.epoch).toBe(0);expect(screen.getByDisplayValue('keep draft')).toBeTruthy();expect(screen.queryByTestId('converged-reader')).toBeNull();
 expect(fetcher.mock.calls).toHaveLength(beforeStay);expect(fetcher.mock.calls.some(([u])=>new URL(String(u),'http://localhost').pathname===`/api/documents/${id}`)).toBe(false);
 confirm.mockReturnValue(true);fireEvent.click(button);const reader=await screen.findByTestId('converged-reader');expect(confirm).toHaveBeenCalledTimes(2);expect(location.search).toBe('?page=documents');expect(lifetime.epoch).toBe(1);expect(reader.dataset.id).toBe(id);expect(reader.dataset.sha).toBe(document.sha256);expect(reader.dataset.scope).toBe(scope);expect(JSON.stringify(history.state)).not.toContain(id);
 await waitFor(()=>expect(fetcher.mock.calls.filter(([u])=>new URL(String(u),'http://localhost').pathname===`/api/documents/${id}`)).toHaveLength(1));
},15_000);
