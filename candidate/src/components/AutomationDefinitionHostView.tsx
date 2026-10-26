import {useEffect,useReducer} from 'react';
import {AutomationManager} from './AutomationManager';
import type {AutomationDefinitionWriteHost} from './automation-definition-write-host';
export function AutomationDefinitionHostView({host,visible}:{host:AutomationDefinitionWriteHost;visible:boolean}){
 const [,render]=useReducer(x=>x+1,0);useEffect(()=>host.subscribe(render),[host]);
 return host.session?<AutomationManager key={host.generationId} session={host.session} manualInventorySession={host.manualInventorySession??undefined} visible={visible} schedulerActive={false} definitionsOnly/>:visible?<p role="status">自动化定义恢复暂不可用：尚未取得固定合成身份范围。</p>:null;
}
