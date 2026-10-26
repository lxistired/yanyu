import {useEffect,useReducer} from 'react';
import {ManualPlanManager, type ManualPlanManagerProps} from './ManualPlanManager';
import type {ManualPlanHost} from './manual-plan-host';
/** Registration/recovery outlives this view. Close calls the shell's one guarded navigation. */
export function ManualPlanHostView({host,onClose,onNavigateMaterial,onOpenPdf,initialMaterialReturn,onOpenConversation}:{host:ManualPlanHost;onClose:()=>void}&Pick<ManualPlanManagerProps,'onNavigateMaterial'|'onOpenPdf'|'initialMaterialReturn'|'onOpenConversation'>) {
 const [,render]=useReducer(x=>x+1,0);useEffect(()=>host.subscribe(render),[host]);
 const session=host.session;
 return session?<ManualPlanManager key={host.identityScope!} session={session} onClose={onClose} onNavigateMaterial={onNavigateMaterial} onOpenPdf={onOpenPdf?(...args)=>{if(host.session===session)onOpenPdf(...args);}:undefined} initialMaterialReturn={initialMaterialReturn} onOpenConversation={onOpenConversation?(source)=>{if(host.session===session)onOpenConversation(source);}:undefined}/>:<p role="status">手工研究计划暂不可用：尚未取得宿主固定合成身份范围。不会使用其他身份重试。</p>;
}
