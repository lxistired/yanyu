import React,{Profiler} from 'react';
import {webcrypto} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {LocalDocuments} from '../candidate/src/components/LocalDocuments';
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
function blocked(){const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();history.replaceState(null,'','/')});
it('records actual dirty listener across success commit and passive-effect cleanup without a manual host',async()=>{
 vi.stubGlobal('crypto',webcrypto);let resolve!:(value:Response)=>void;
 const active=new Set<EventListenerOrEventListenerObject>(),events:unknown[]=[];
 const add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window);
 vi.spyOn(window,'addEventListener').mockImplementation(((type:string,listener:EventListenerOrEventListenerObject,options?:unknown)=>{if(type==='beforeunload'){active.add(listener);events.push({event:'add',name:typeof listener==='function'?listener.name:'object'});}return add(type,listener,options as boolean)}) as typeof window.addEventListener);
 vi.spyOn(window,'removeEventListener').mockImplementation(((type:string,listener:EventListenerOrEventListenerObject,options?:unknown)=>{if(type==='beforeunload'){active.delete(listener);events.push({event:'remove',name:typeof listener==='function'?listener.name:'object'});}return remove(type,listener,options as boolean)}) as typeof window.removeEventListener);
 vi.stubGlobal('fetch',vi.fn((input:unknown)=>{const p=String(input);if(p==='/api/documents/choices')return Promise.resolve(json({uploadScope:'10000000-0000-4000-8000-000000000001',workspaces:[],folders:[]}));if(p.startsWith('/api/documents?'))return Promise.resolve(json({storeScope:'10000000-0000-4000-8000-000000000001',documents:[],total:0,offset:0,limit:10}));if(p==='/api/documents/folders')return new Promise<Response>(r=>resolve=r);throw Error('Unexpected synthetic route');}));
 const commits:{activeListeners:number;blocked:boolean}[]=[];
 render(<Profiler id="synthetic-folder" onRender={()=>{if(screen.queryByText('本地文件夹已创建'))commits.push({activeListeners:active.size,blocked:blocked()});}}><LocalDocuments/></Profiler>);
 await screen.findByText('没有匹配的文档。上传文件，或调整筛选条件。');
 fireEvent.change(screen.getByLabelText('新文件夹名称'),{target:{value:'synthetic'}});expect(active.size).toBe(1);expect(blocked()).toBe(true);
 fireEvent.submit(screen.getByLabelText('新文件夹名称').closest('form')!);
 await act(async()=>resolve(json({folder:{id:'40000000-0000-4000-8000-000000000004',name:'synthetic',workspaceId:null}})));
 expect(screen.getByText('本地文件夹已创建')).toBeTruthy();expect((screen.getByLabelText('新文件夹名称') as HTMLInputElement).value).toBe('');
 expect(commits.length).toBeGreaterThan(0);expect(commits.every(c=>c.activeListeners===0&&!c.blocked)).toBe(true);expect(active.size).toBe(0);expect(blocked()).toBe(false);
 expect(events).toEqual([{event:'add',name:'warn'},{event:'remove',name:'warn'}]);
 console.log('FOLDER_EFFECT_LIFECYCLE',JSON.stringify({commits,events,finalBlocked:blocked(),manualSessionListener:false}));
});
