import React,{useState,StrictMode} from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {useUnsavedWork} from '../candidate/src/components/unsaved-work';
import * as unsavedHistory from '../candidate/src/components/unsaved-work';
import {flushSync} from 'react-dom';
import type {PdfOpenIntent} from '../candidate/src/components/pdf-open-intent';
const shared=vi.hoisted(()=>({open:null as null|((value:any,context?:any)=>void),intent:null as PdfOpenIntent|null}));
vi.mock('../candidate/src/components/LocalResearchSearch',()=>({LocalResearchSearch:({onOpenPdf}:any)=>{shared.open=onOpenPdf;const[value,set]=useState('');useUnsavedWork(!!value);return <input aria-label="search draft" value={value} onChange={e=>set(e.target.value)}/>;}}));
vi.mock('../candidate/src/components/LocalRecentMaterials',()=>({LocalRecentMaterials:({onOpenPdf,initialDocumentReturn}:any)=>{shared.open=onOpenPdf;return <p data-testid="recent-return">{initialDocumentReturn?.offset??0}</p>;}}));
vi.mock('../candidate/src/components/LocalDocuments',()=>({LocalDocuments:({pdfOpenIntent}:any)=>{shared.intent=pdfOpenIntent;return <p data-testid="docs">{pdfOpenIntent?'selected':'plain'}</p>;}}));
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
const pin={storeScope:'10000000-0000-4000-8000-000000000001',documentId:'20000000-0000-4000-8000-000000000002',format:'pdf',sha256:'a'.repeat(64),pages:1,revision:0,workspaceId:null,folderId:null};
afterEach(()=>{cleanup();vi.restoreAllMocks();history.replaceState(null,'','/');shared.open=null;shared.intent=null;});
function start(page='research',strict=false){history.replaceState(null,'',`/?page=${page}`);const life=new OrdinaryRequestLifetime();const shell=<OrdinaryNavigationShell lifetime={life}/>;const tree=render(strict?<StrictMode>{shell}</StrictMode>:shell);return{life,...tree};}
function select(value:unknown=pin,context?:unknown){act(()=>shared.open!(value,context));}
it.each(['research','tasks'])('%s selection stays ephemeral and reaches documents',page=>{const {life}=start(page);select();expect(screen.getByTestId('docs').textContent).toBe('selected');expect(shared.intent?.selection).toEqual(pin);expect(shared.intent?.current()).toBe(true);expect(life.epoch).toBe(1);expect(location.search).toBe('?page=documents');expect(JSON.stringify(history.state)).not.toContain(pin.documentId);});
it('Stay preserves draft, URL and epoch; no intent admitted',()=>{vi.spyOn(window,'confirm').mockReturnValue(false);const {life}=start();fireEvent.change(screen.getByLabelText('search draft'),{target:{value:'keep'}});select();expect(screen.getByDisplayValue('keep')).toBeTruthy();expect(shared.intent).toBeNull();expect(life.epoch).toBe(0);expect(location.search).toBe('?page=research');expect(window.confirm).toHaveBeenCalledOnce();});
it('Leave asks once then admits',()=>{vi.spyOn(window,'confirm').mockReturnValue(true);start();fireEvent.change(screen.getByLabelText('search draft'),{target:{value:'leave'}});select();expect(shared.intent?.current()).toBe(true);expect(window.confirm).toHaveBeenCalledOnce();});
it('failed history write never accepts a selection',()=>{const {life}=start();vi.spyOn(history,'pushState').mockImplementation(()=>{throw Error('synthetic refusal');});select();expect(shared.intent).toBeNull();expect(life.epoch).toBe(0);expect(location.search).toBe('?page=research');});
it('malformed pin is rejected before leave prompt/history',()=>{vi.spyOn(window,'confirm').mockReturnValue(true);const {life}=start();select({...pin,revision:-1});expect(shared.intent).toBeNull();expect(life.epoch).toBe(0);expect(window.confirm).not.toHaveBeenCalled();});
it('a callback retained from the unmounted producer cannot replace the current selection',()=>{const {life}=start();select();const previous=shared.intent!;select({...pin,revision:1});expect(life.epoch).toBe(1);expect(previous.current()).toBe(true);expect(shared.intent).toBe(previous);expect(shared.intent?.selection.revision).toBe(0);});
it('a newer action from the freshly mounted producer creates a new one-shot selection',async()=>{const {life}=start();select();const previous=shared.intent!;await act(async()=>{history.back();await new Promise(r=>setTimeout(r,65));});expect(previous.current()).toBe(false);select({...pin,revision:1});expect(life.epoch).toBe(3);expect(shared.intent?.selection.revision).toBe(1);expect(shared.intent?.current()).toBe(true);});
it.each(['ordinary','replace','pop'])('%s route withdraws pending selection',kind=>{start();select();const previous=shared.intent!;if(kind==='ordinary')fireEvent.click(screen.getByRole('button',{name:'首页',exact:true}));if(kind==='replace')fireEvent.click(screen.getByText('替换当前路由并刷新'));if(kind==='pop')act(()=>{history.replaceState(null,'','/?page=documents');window.dispatchEvent(new PopStateEvent('popstate'));});expect(previous.current()).toBe(false);if(kind!=='ordinary')expect(screen.getByTestId('docs').textContent).toBe('plain');});
it('actual Back and Forward never replay consumed route intent',async()=>{start();select();const old=shared.intent!;await act(async()=>{history.back();await new Promise(r=>setTimeout(r,65));});expect(old.current()).toBe(false);await act(async()=>{history.forward();await new Promise(r=>setTimeout(r,65));});expect(screen.getByTestId('docs').textContent).toBe('plain');});
it('shell StrictMode effect replay leaves current selection admissible, unmount ends ownership',()=>{const tree=start('research',true);select();const previous=shared.intent!;expect(previous.current()).toBe(true);tree.unmount();expect(previous.current()).toBe(false);});
it('identity scope change ends ownership',()=>{const tree=start();select();const previous=shared.intent!;tree.rerender(<OrdinaryNavigationShell lifetime={tree.life} identityScope="new-synthetic-owner"/>);expect(previous.current()).toBe(false);});
it('external documents URL remains plain without intent',()=>{history.replaceState(null,'',`/?page=documents&documentId=${pin.documentId}`);render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()}/>);expect(screen.getByTestId('docs').textContent).toBe('plain');});

it('returning identity cannot resurrect a withdrawn intent',()=>{const tree=start();select();const previous=shared.intent!;tree.rerender(<OrdinaryNavigationShell lifetime={tree.life} identityScope="other"/>);tree.rerender(<OrdinaryNavigationShell lifetime={tree.life}/>);expect(previous.current()).toBe(false);});
it('ordinary documents action withdraws pending selection even on same route',()=>{const {life}=start();select();const previous=shared.intent!;fireEvent.click(screen.getByRole('button',{name:'文档',exact:true}));expect(previous.current()).toBe(false);expect(life.epoch).toBe(2);expect(screen.getByTestId('docs').textContent).toBe('plain');});

// Source-only assertions for the separate document return ticket boundary.
const documentReturn=()=>({documentStoreId:pin.storeScope,offset:10});
async function back(){await act(async()=>{history.back();await new Promise(r=>setTimeout(r,65));});}
it.each([undefined,null,{}, {documentStoreId:pin.storeScope,offset:1}, {documentStoreId:'30000000-0000-4000-8000-000000000003',offset:10}])('invalid or mismatched optional context %j never disables a valid PDF open',async context=>{
 start('tasks');select(pin,context);expect(shared.intent?.current()).toBe(true);expect(location.search).toBe('?page=documents');
 await back();expect(screen.getByTestId('recent-return').textContent).toBe('0');
});
it('copies document context and restores it only on the exact accepted tasks entry',async()=>{
 start('tasks');const context=documentReturn();select(pin,context);context.offset=20;
 expect(shared.intent?.selection).toEqual(pin);expect(Object.keys(shared.intent!.selection).sort()).not.toContain('offset');
 await back();expect(screen.getByTestId('recent-return').textContent).toBe('10');
});
it('research cannot register a recent-document ticket even if a caller supplies its shape',async()=>{
 start('research');select(pin,documentReturn());await back();expect(location.search).toBe('?page=research');expect(screen.getByLabelText('search draft')).toBeTruthy();
});
it('a foreign origin entry cannot acquire a document return ticket',async()=>{
 start('tasks');history.replaceState(null,'','/?page=tasks');select(pin,documentReturn());expect(shared.intent?.current()).toBe(true);
 await back();expect(screen.getByTestId('recent-return').textContent).toBe('0');
});
it('identity drift during leave confirmation preserves the current route and registers no selection',()=>{
 const tree=start();fireEvent.change(screen.getByLabelText('search draft'),{target:{value:'retain'}});
 vi.spyOn(window,'confirm').mockImplementation(()=>{flushSync(()=>tree.rerender(<OrdinaryNavigationShell lifetime={tree.life} identityScope="changed"/>));return true;});
 select();expect(location.search).toBe('?page=research');expect(tree.life.epoch).toBe(0);expect(shared.intent).toBeNull();
});
it('identity drift after a successful write accepts actual route without registering intent or return ticket',async()=>{
 const tree=start('tasks'),write=unsavedHistory.writeUnsavedHistory;
 vi.spyOn(unsavedHistory,'writeUnsavedHistory').mockImplementation((url,replace)=>{
  const accepted=write(url,replace);flushSync(()=>tree.rerender(<OrdinaryNavigationShell lifetime={tree.life} identityScope="changed"/>));return accepted;
 });
 select(pin,documentReturn());expect(location.search).toBe('?page=documents');expect(screen.getByTestId('docs').textContent).toBe('plain');expect(shared.intent).toBeNull();expect(tree.life.epoch).toBe(1);
 await back();expect(screen.getByTestId('recent-return').textContent).toBe('0');
});
it('an accepted nonmatching foreign traversal clears rather than postpones document return',async()=>{
 start('tasks');select(pin,documentReturn());
 act(()=>{history.pushState(null,'','/?page=home');window.dispatchEvent(new PopStateEvent('popstate'));});
 await back();expect(screen.getByTestId('docs').textContent).toBe('plain');await back();expect(screen.getByTestId('recent-return').textContent).toBe('0');
});
