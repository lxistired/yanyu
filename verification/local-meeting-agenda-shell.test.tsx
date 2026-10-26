import React,{useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,act} from '@testing-library/react';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrganizationWriteHost} from '../candidate/src/components/organization-write-host';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {useUnsavedWork,writeUnsavedHistory} from '../candidate/src/components/unsaved-work';
vi.mock('../candidate/src/components/WorkspaceManager',()=>({WorkspaceManager:()=>{const [value,setValue]=useState('');useUnsavedWork(!!value);return <input aria-label="Workspace dirty fixture" value={value} onChange={e=>setValue(e.target.value)}/>;}}));
vi.mock('../candidate/src/components/OrganizationManager',()=>({OrganizationManager:()=>{const [value,setValue]=useState('');useUnsavedWork(!!value);return <input aria-label="Organization dirty fixture" value={value} onChange={e=>setValue(e.target.value)}/>;}}));
// Persistent service owner isolates cross-component dirty veto without unrelated service traffic.
vi.mock('../candidate/src/components/ServiceReportsEntry',()=>({ServiceReportsEntry:()=>{const [value,setValue]=useState('');useUnsavedWork(!!value);return <input aria-label="Persistent dirty fixture" value={value} onChange={e=>setValue(e.target.value)}/>;}}));
vi.mock('../candidate/src/components/AutomationManager',()=>({AutomationManager:(props:{schedulerActive:boolean;definitionsOnly:boolean})=><div data-testid="automation-contract">{JSON.stringify(props)}</div>}));
type Pending={url:string;init:RequestInit;resolve:(v:Response)=>void;reject:(e:Error)=>void};
let calls:Pending[]=[];
const row=(id:string,state='scheduled')=>({id,kind:'meeting',revision:1,createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',deletedAt:null,data:{title:'Meeting '+id,organizationId:null,series:'',category:'research',startsAt:'2026-10-21T00:00:00.000Z',endsAt:'2026-10-21T01:00:00.000Z',timezone:'Asia/Shanghai',location:'Room A',description:'',attendeeIds:[],state,providerAvailability:'unconfigured'}});
const page=(ids:string[]=[],offset=0,total=ids.length,nextOffset:number|null=null,state='scheduled')=>({items:ids.map(id=>row(id,state)),total,offset,nextOffset});
function start(route='home',host?:OrganizationWriteHost){
 history.replaceState(null,'','/?page='+route);calls=[];
 vi.stubGlobal('fetch',vi.fn((url:string,init:RequestInit)=>new Promise<Response>((resolve,reject)=>calls.push({url,init,resolve,reject}))));
 const life=new OrdinaryRequestLifetime();render(<OrdinaryNavigationShell lifetime={life} organizationWriteHost={host}/>);return life;
}
const settle=async(index:number,value:unknown)=>{await act(async()=>{calls[index].resolve(new Response(JSON.stringify(value),{status:200}));});};
const nav=(label:string)=>fireEvent.click(screen.getAllByRole('button',{name:label,exact:true})[0]);
const traverse=async(direction:'back'|'forward')=>{await act(async()=>{history[direction]();await new Promise(r=>setTimeout(r,90));});};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();history.replaceState(null,'','/');});
it('home entry mounts read-only agenda, route Back/Forward actually traverses and remounts without old results',async()=>{
 const life=start();expect(screen.getAllByRole('button',{name:'本地会议日程',exact:true}).length).toBeGreaterThanOrEqual(1);
 nav('本地会议日程');expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(1);expect(calls).toHaveLength(1);
 await settle(0,page(['initial']));expect(screen.getByText('Meeting initial')).toBeTruthy();
 await traverse('back');expect(location.search).toBe('?page=home');expect(calls[0].init.signal?.aborted).toBe(true);expect(screen.queryByText('Meeting initial')).toBeNull();
 await traverse('forward');expect(location.search).toBe('?page=calendar');expect(calls).toHaveLength(2);expect(screen.queryByText('Meeting initial')).toBeNull();await settle(1,page(['return']));expect(screen.getByText('Meeting return')).toBeTruthy();
 expect(calls.every(c=>c.url==='/api/organization/list'&&c.init.method==='POST')).toBe(true);
});
it('workspace and organization dirty owners veto entry without advancing epoch or fetching; explicit discard works',async()=>{
 for(const [route,label] of [['workspace','Workspace dirty fixture'],['organization','Organization dirty fixture']]){
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const life=start(route);fireEvent.change(screen.getByLabelText(label),{target:{value:'keep'}});nav('本地会议日程');expect(location.search).toBe('?page='+route);expect(life.epoch).toBe(0);expect(calls).toHaveLength(0);expect(screen.getByDisplayValue('keep')).toBeTruthy();
  confirm.mockReturnValue(true);nav('本地会议日程');expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(1);expect(calls).toHaveLength(1);await settle(0,page());cleanup();vi.restoreAllMocks();
 }
});
it('generic management callback uses dirty guard/history, no guessed meeting deep link; rejected actual Back preserves organization draft',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const life=start('calendar');await settle(0,page(['a']));
 fireEvent.change(screen.getByLabelText('Persistent dirty fixture'),{target:{value:'report draft'}});fireEvent.click(screen.getByText('在机构管理中管理会议'));expect(location.search).toBe('?page=calendar');expect(life.epoch).toBe(0);expect(screen.getByText('Meeting a')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Persistent dirty fixture'),{target:{value:''}});fireEvent.click(screen.getByText('在机构管理中管理会议'));expect(location.search).toBe('?page=organization');expect(calls[0].init.signal?.aborted).toBe(true);
 fireEvent.change(screen.getByLabelText('Organization dirty fixture'),{target:{value:'org draft'}});await traverse('back');expect(location.search).toBe('?page=organization');expect(screen.getByDisplayValue('org draft')).toBeTruthy();expect(life.epoch).toBe(1);
 confirm.mockReturnValue(true);await traverse('back');expect(location.search).toBe('?page=calendar');expect(calls).toHaveLength(2);await settle(1,page());
});
it('route exit while JSON parsing is pending aborts and suppresses old agenda after a later calendar visit',async()=>{
 start('calendar');let release!:(v:unknown)=>void;const delayed=new Promise(resolve=>release=resolve);
 await act(async()=>{calls[0].resolve({ok:true,status:200,json:()=>delayed} as Response);});
 nav('首页');expect(calls[0].init.signal?.aborted).toBe(true);nav('本地会议日程');await settle(1,page(['new']));
 await act(async()=>release(page(['stale'])));expect(screen.getByText('Meeting new')).toBeTruthy();expect(screen.queryByText('Meeting stale')).toBeNull();
});
it('mounted filter/paging and replacement route keep exact nextOffset, reset offset and abort pending requests',async()=>{
 start('calendar');await settle(0,page(['a','b'],0,4,2));fireEvent.click(screen.getByText('下一页'));expect(JSON.parse(calls[1].init.body as string).offset).toBe(2);
 await settle(1,page(['c'],2,4,3));fireEvent.click(screen.getByText('上一页'));expect(JSON.parse(calls[2].init.body as string).offset).toBe(0);
 fireEvent.change(screen.getByLabelText('会议状态'),{target:{value:'completed'}});expect(calls[2].init.signal?.aborted).toBe(true);expect(JSON.parse(calls[3].init.body as string)).toMatchObject({state:'completed',offset:0});await settle(3,page(['complete'],0,1,null,'completed'));await settle(2,page(['stale'],0,4,1));expect(screen.queryByText('Meeting stale')).toBeNull();
 fireEvent.click(screen.getByText('替换当前路由并刷新'));expect(calls[3].init.signal?.aborted).toBe(true);expect(JSON.parse(calls[4].init.body as string)).not.toHaveProperty('state');expect(screen.queryByText('Meeting complete')).toBeNull();await settle(4,page());
});
it('planner fails closed without host identity, automation remains definition-only and local/external wording is honest',()=>{
 start('planner');expect(screen.getByText('手工研究计划暂不可用：宿主未提供受信任的固定合成身份。')).toBeTruthy();expect(screen.getByRole('heading',{level:1}).textContent).toBe('手工研究计划');expect(calls).toHaveLength(0);expect(screen.getByText(/本地已保存会议可在本地会议日程/)).toBeTruthy();nav('首页');nav('自动化');expect(screen.getByTestId('automation-contract').textContent).toBe('{"schedulerActive":false,"definitionsOnly":true}');expect(calls).toHaveLength(0);
});
it('date range survives management round trip and actual Back, with fresh reads instead of cached meetings',async()=>{
 start('calendar');await settle(0,page());
 fireEvent.change(screen.getByLabelText('浏览日期（UTC）'),{target:{value:'2026-10-21'}});await settle(1,page(['a']));
 fireEvent.click(screen.getByRole('button',{name:'周视图'}));await settle(2,page(['a']));
 fireEvent.click(screen.getByText('在机构管理中管理会议'));expect(location.search).toBe('?page=organization');
 await traverse('back');expect(location.search).toBe('?page=calendar');expect(JSON.parse(calls[3].init.body as string)).toMatchObject({from:'2026-10-19T00:00:00.000Z',to:'2026-10-26T00:00:00.000Z',offset:0});
 expect(screen.queryByText('Meeting a')).toBeNull();await settle(3,page(['b']));expect(screen.getByText('Meeting b')).toBeTruthy();expect(screen.getByRole('button',{name:'周视图'}).getAttribute('aria-pressed')).toBe('true');
});

it('selected meeting route returns to the saved day, consumes restoration, and unrelated later visits do not resurrect old filters',async()=>{
 const host=new OrganizationWriteHost();host.activate();host.setAuthority('a'.repeat(64),true);
 try {
  start('calendar',host);await settle(0,page());
  fireEvent.change(screen.getByLabelText('浏览日期（UTC）'),{target:{value:'2026-10-21'}});await settle(1,page(['a']));
  fireEvent.click(screen.getByRole('button',{name:'打开此会议记录：Meeting a'}));expect(location.search).toBe('?page=organization');
  await traverse('back');expect(JSON.parse(calls[2].init.body as string)).toMatchObject({from:'2026-10-21T00:00:00.000Z',to:'2026-10-22T00:00:00.000Z'});await settle(2,page(['a']));
  fireEvent.click(screen.getByRole('button',{name:'清空全部筛选'}));await settle(3,page());
  nav('首页');nav('本地会议日程');expect(JSON.parse(calls[4].init.body as string)).not.toHaveProperty('from');await settle(4,page());
 } finally {cleanup();host.dispose();}
});
