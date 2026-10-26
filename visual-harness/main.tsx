import {WorkspaceWriteHost} from '../candidate/src/components/workspace-write-host';
import {AutomationDefinitionWriteHost} from '../candidate/src/components/automation-definition-write-host';
import {allowLeavingUnsavedWork} from '../candidate/src/components/unsaved-work';
import {InventorySchedules} from './InventorySchedules';
import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OrdinaryNavigationShell} from '../candidate/src/components/OrdinaryNavigationShell';
import {OrdinaryRequestLifetime} from '../candidate/src/components/ordinary-navigation';
import {OrganizationWriteHost} from '../candidate/src/components/organization-write-host';
import {ManualPlanHost} from '../candidate/src/components/manual-plan-host';
import {boundedTransport} from './bounded-transport';
import '../candidate/src/styles.css';
const lifetime=new OrdinaryRequestLifetime();
window.fetch=boundedTransport(lifetime,window.fetch.bind(window));
function Demo(){
 const [workspaceWriteHost]=useState(()=>new WorkspaceWriteHost());
 useEffect(()=>{workspaceWriteHost.activate();return()=>workspaceWriteHost.dispose();},[workspaceWriteHost]);
 const [automationDefinitionWriteHost]=useState(()=>new AutomationDefinitionWriteHost());
 useEffect(()=>{automationDefinitionWriteHost.activate();return()=>automationDefinitionWriteHost.dispose();},[automationDefinitionWriteHost]);
 const [organizationWriteHost]=useState(()=>new OrganizationWriteHost());
 useEffect(()=>{organizationWriteHost.activate();return()=>organizationWriteHost.dispose();},[organizationWriteHost]);
 const [manualPlanHost]=useState(()=>new ManualPlanHost(window.fetch.bind(window)));
 useEffect(()=>{manualPlanHost.activate();return()=>manualPlanHost.dispose();},[manualPlanHost]);
 const [inventory,setInventory]=useState(false);
 const [scope,setScope]=useState<string|null>(null);
 useEffect(()=>{const controller=new AbortController();void fetch('/api/demo/identity',{signal:controller.signal}).then(async r=>{if(!r.ok)throw Error('Identity unavailable');const v=await r.json();if(!controller.signal.aborted && typeof v.identityScope==='string' && /^[a-f0-9]{64}$/.test(v.identityScope)){workspaceWriteHost.setAuthority(v.identityScope,true);manualPlanHost.setAuthority(v.identityScope,true);organizationWriteHost.setAuthority(v.identityScope,true);automationDefinitionWriteHost.setAuthority(v.identityScope,true);setScope(v.identityScope);}}).catch(()=>{});return()=>controller.abort();},[manualPlanHost,organizationWriteHost,automationDefinitionWriteHost,workspaceWriteHost]);
 return <><nav aria-label="本地清单入口" className="local-inventory-entry"><button onClick={()=>{if(allowLeavingUnsavedWork())setInventory(v=>!v)}}>{inventory?'返回文档工作台':'本地文档清单计划'}</button></nav>{inventory?<InventorySchedules/>:<OrdinaryNavigationShell lifetime={lifetime} identityScope={scope} manualPlanHost={manualPlanHost} organizationWriteHost={organizationWriteHost} automationDefinitionWriteHost={automationDefinitionWriteHost} workspaceWriteHost={workspaceWriteHost}/>}</>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
