import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {syntheticTransport} from '../visual-harness/synthetic-transport';
import {boundedTransport} from '../visual-harness/bounded-transport';
vi.mock('../candidate/src/components/WorkspaceManager',()=>({WorkspaceManager:({initialWorkspaceId,onWorkspaceChange}:any)=><section><label>Workspace draft<input aria-label="Workspace draft"/></label><button onClick={()=>onWorkspaceChange('ws-2')}>Select ws-2</button><p>Selected {initialWorkspaceId}</p></section>}));
vi.mock('../candidate/src/components/OrganizationManager',()=>({OrganizationManager:()=> <p>Organization leaf</p>}));
vi.mock('../candidate/src/components/AutomationManager',()=>({AutomationManager:()=> <p>Automation leaf</p>}));
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:({visible,routeEpoch,identityScope,available,mailAvailable}:any)=><section data-testid="reports" data-epoch={routeEpoch} data-visible={visible} data-scope={identityScope??'null'} data-available={available} data-mail-available={mailAvailable}><input aria-label="Report draft"/></section>}));
vi.mock('../candidate/src/components/FeedbackSettingsEntry',()=>({FeedbackSettingsEntry:({expectedOwnerScope,available}:any)=><p>Feedback {String(available)} {String(expectedOwnerScope)}</p>}));
vi.mock('../candidate/src/components/LocalMeetingAgenda',()=>({LocalMeetingAgenda:()=> <h2>本地会议议程 fixture</h2>}));
vi.mock('../candidate/src/components/LocalResearchSearch',()=>({LocalResearchSearch:()=> <h2>本地资料检索</h2>}));
afterEach(()=>{cleanup();vi.useRealTimers();history.replaceState(null,'','/');vi.unstubAllGlobals();vi.restoreAllMocks();});
it.each([['关闭说明','?page=settings'],['查看手动模型计划用量','?page=usage'],['查看服务与显示偏好','?page=settings']] as const)('real HelpContent shell %s keeps its destination after queued close',async(name,url)=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);history.replaceState(null,'','/?page=settings&panel=help');
 render(<OrdinaryNavigationShell lifetime={new OrdinaryRequestLifetime()}/>);
 expect(screen.getByText('此入口未读取实时服务状态；请以各功能页显示的当前可用状态为准。')).toBeTruthy();
 expect(screen.queryByText('服务状态读取失败，当前能力未知。')).toBeNull();expect(screen.queryByRole('heading',{name:'通知范围'})).toBeNull();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name}));await Promise.resolve();});
 expect(location.search).toBe(url);expect(screen.queryByRole('button',{name:'关闭说明'})).toBeNull();expect(fetch).not.toHaveBeenCalled();
});
it('shell selects explicit synthetic provenance at the real capability leaf',async()=>{
 const native=vi.fn();const life=new OrdinaryRequestLifetime();vi.stubGlobal('fetch',boundedTransport(life,native));history.replaceState(null,'','/?page=settings&panel=capabilities');
 render(<OrdinaryNavigationShell lifetime={life}/>);
 expect(screen.getByRole('region',{name:'合成能力展示'})).toBeTruthy();await screen.findByRole('heading',{name:'本地合成文本模型 · 未配置'});
 fireEvent.click(within(screen.getByRole('navigation',{name:'服务与接入页面'})).getByRole('button',{name:'使用说明',exact:true}));
 expect(screen.getByText('此入口未读取实时服务状态；请以各功能页显示的当前可用状态为准。')).toBeTruthy();expect(screen.queryByRole('region',{name:'合成能力展示'})).toBeNull();expect(native).not.toHaveBeenCalled();
});

it('late synthetic capability reply cannot repopulate after leaving the settings route',async()=>{
 vi.useFakeTimers();const life=new OrdinaryRequestLifetime();const fetch=vi.fn(syntheticTransport(life,20));vi.stubGlobal('fetch',fetch);
 history.replaceState(null,'','/?page=settings&panel=capabilities');render(<OrdinaryNavigationShell lifetime={life}/>);
 const signal=fetch.mock.calls[0][1]?.signal;expect(signal?.aborted).toBe(false);
 fireEvent.click(within(screen.getByRole('navigation',{name:'服务与接入页面'})).getByRole('button',{name:'使用说明',exact:true}));expect(signal?.aborted).toBe(true);
 await act(async()=>{await vi.advanceTimersByTimeAsync(20);});
 expect(screen.getByText('此入口未读取实时服务状态；请以各功能页显示的当前可用状态为准。')).toBeTruthy();
 expect(screen.queryByRole('heading',{name:'本地合成文本模型 · 未配置'})).toBeNull();expect(fetch).toHaveBeenCalledOnce();
});
