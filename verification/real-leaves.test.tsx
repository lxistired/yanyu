import React from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup,waitFor} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {syntheticTransport} from '../visual-harness/synthetic-transport';
afterEach(()=>{cleanup();vi.unstubAllGlobals();history.replaceState(null,'','/');});
it.each(['workspace','organization','automation','usage','settings&panel=feedback','settings&panel=capabilities','settings&panel=help'])('renders actual ordinary leaf %s without live fetch',async(page)=>{
 const life=new OrdinaryRequestLifetime();const fetch=vi.fn(syntheticTransport(life));vi.stubGlobal('fetch',fetch);history.replaceState(null,'',`/?page=${page}`);
 render(<OrdinaryNavigationShell lifetime={life}/>);
 await waitFor(()=>expect(screen.queryByText('正在加载…')).toBeNull());
 expect(document.querySelector('iframe')).toBeNull();expect(screen.getAllByRole('heading',{level:1}).length).toBeGreaterThan(0);
 await new Promise(resolve=>setTimeout(resolve,20));
 for(const call of fetch.mock.calls) expect(String(call[0])).toMatch(/^\/api\//);
});
it('synthetic transport blocks external URL and unknown API; never falls back to network',async()=>{const fetch=syntheticTransport(new OrdinaryRequestLifetime());expect((await fetch('https://example.test')).status).toBe(503);expect((await fetch('/api/unknown')).status).toBe(503);});
it('late capabilities response cannot repopulate the departed settings leaf',async()=>{
 const life=new OrdinaryRequestLifetime();let resolve!:(value:Response)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>resolve=r)));
 history.replaceState(null,'','/?page=settings&panel=capabilities');render(<OrdinaryNavigationShell lifetime={life}/>);
 const {fireEvent,act}=await import('@testing-library/react');
 fireEvent.click(screen.getByRole('button',{name:'设置概览',exact:true}));
 await act(async()=>resolve(new Response(JSON.stringify([{id:'stale',label:'STALE CAPABILITY',kind:'model.audio',implemented:true,configured:false,available:false,reason:'unconfigured'}]),{status:200,headers:{'Content-Type':'application/json'}})));
 expect(screen.queryByText('STALE CAPABILITY')).toBeNull();expect(location.search).toBe('?page=settings');
});

it('rejected unknown history retains workspace draft and reports URL mismatch without rewriting foreign state',async()=>{
 const {fireEvent,act}=await import('@testing-library/react');
 const life=new OrdinaryRequestLifetime();vi.stubGlobal('fetch',vi.fn(syntheticTransport(life)));vi.spyOn(window,'confirm').mockReturnValue(false);
 history.replaceState(null,'','/?page=workspace');render(<OrdinaryNavigationShell lifetime={life}/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'新建工作区'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'新建工作区'}));fireEvent.change(screen.getByLabelText('工作区名称'),{target:{value:'Preserve actual leaf draft'}});
 const foreignState={externalOwner:'synthetic-external-history'};
 act(()=>{history.replaceState(foreignState,'','/?page=home');window.dispatchEvent(new PopStateEvent('popstate',{state:foreignState}));});
 expect(screen.getByDisplayValue('Preserve actual leaf draft')).toBeTruthy();expect(location.search).toBe('?page=home');expect(history.state).toEqual(foreignState);expect(screen.getAllByText(/地址栏可能与页面不同/).length).toBeGreaterThan(0);expect(window.confirm).toHaveBeenCalledTimes(1);expect(life.epoch).toBe(0);vi.restoreAllMocks();
});
