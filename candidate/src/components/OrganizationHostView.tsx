import type {MeetingOpenIntent} from './meeting-open-intent';
import {useEffect,useLayoutEffect,useReducer} from 'react';
import {OrganizationManager} from './OrganizationManager';
import type {OrganizationWriteHost} from './organization-write-host';
export function OrganizationHostView({host,visible,routeEpoch,meetingOpenIntent=null}:{meetingOpenIntent?:MeetingOpenIntent|null;host:OrganizationWriteHost;visible:boolean;routeEpoch:number}) {
 const [,render]=useReducer(x=>x+1,0);useEffect(()=>host.subscribe(render),[host]);
 useLayoutEffect(()=>{const session=host.projection;session?.setView(visible,routeEpoch);return()=>session?.setView(false,routeEpoch);},[host,host.generationId,visible,routeEpoch]);
 return host.session?<OrganizationManager key={host.generationId} session={host.session} projection={{mode:'v2',session:host.projection}} visible={visible} routeEpoch={routeEpoch} meetingOpenIntent={meetingOpenIntent}/>:visible?<p role="status">机构恢复暂不可用：尚未取得固定合成身份范围，不会使用其他身份重试。</p>:null;
}
