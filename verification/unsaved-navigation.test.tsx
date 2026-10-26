import {writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
import React,{useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,act} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {useUnsavedWork} from '../candidate/src/components/unsaved-work';
vi.mock('../candidate/src/components/WorkspaceManager',()=>({WorkspaceManager:()=>{const [value,setValue]=useState('');useUnsavedWork(!!value);return <input aria-label="Synthetic workspace draft" value={value} onChange={e=>setValue(e.target.value)}/>;}}));
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>null}));
afterEach(()=>{cleanup();vi.restoreAllMocks();history.replaceState(null,'','/');});
function start(){history.replaceState(null,'','/?page=workspace');const life=new OrdinaryRequestLifetime();render(<OrdinaryNavigationShell lifetime={life}/>);fireEvent.change(screen.getByLabelText('Synthetic workspace draft'),{target:{value:'keep this draft'}});return life;}
it('cancelled route navigation keeps draft, route, and request epoch',()=>{const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const life=start();fireEvent.click(screen.getByRole('button',{name:'首页',exact:true}));expect(confirm).toHaveBeenCalledOnce();expect(location.search).toBe('?page=workspace');expect(screen.getByDisplayValue('keep this draft')).toBeTruthy();expect(life.epoch).toBe(0);});
it('explicit discard navigates and removes dirty marker',()=>{vi.spyOn(window,'confirm').mockReturnValue(true);const life=start();fireEvent.click(screen.getByRole('button',{name:'首页',exact:true}));expect(location.search).toBe('?page=home');expect(screen.queryByDisplayValue('keep this draft')).toBeNull();expect(life.epoch).toBe(1);});
it('cancelled actual Back restores accepted entry without losing draft',async()=>{vi.spyOn(window,'confirm').mockReturnValue(false);const life=start();act(()=>prepareOwnedHistory('/?page=home'));await historyBack();expect(location.search).toBe('?page=workspace');expect(screen.getByDisplayValue('keep this draft')).toBeTruthy();expect(life.epoch).toBe(0);});
it('cancelled refresh-route action leaves editor mounted',()=>{vi.spyOn(window,'confirm').mockReturnValue(false);const life=start();fireEvent.click(screen.getByText('替换当前路由并刷新'));expect(screen.getByDisplayValue('keep this draft')).toBeTruthy();expect(life.epoch).toBe(0);});

function prepareOwnedHistory(target:string){const current=location.href;writeUnsavedHistory(target);writeUnsavedHistory(current)}
async function historyBack(){await act(async()=>{history.back();await new Promise(r=>setTimeout(r,65))})}
