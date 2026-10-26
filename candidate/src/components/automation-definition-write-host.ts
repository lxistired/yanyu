import {ManualInventorySession} from './manual-inventory-session';
import {AutomationDefinitionWriteSession} from './automation-definition-write-session';
import {allowLeavingUnsavedWork,registerUnsavedSession} from './unsaved-work';
/** Host scope is the fixed synthetic /api/demo/identity scope, not real authentication. */
export class AutomationDefinitionWriteHost {
 private authority:string|null=null;private generation=0;private active=false;
 private manual:ManualInventorySession|null=null;
 private current:AutomationDefinitionWriteSession|null=null;private unregister:(()=>void)|null=null;
 private listeners=new Set<()=>void>();private token=Symbol('automation-definition-recovery');private scope=Symbol('automation-definition-owner');
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 get session(){return this.current;}
 get manualInventorySession(){return this.manual;}
 get generationId(){return this.generation;}
 get identityScope(){return this.authority;}
 private emit(){for(const f of this.listeners)f();}
 private register(){if(this.active&&this.current)this.unregister=registerUnsavedSession({token:this.token,scope:this.scope,getState:()=>{const definition=this.current?.unsavedState(),manual=this.manual?.unsavedState();return {dirty:!!definition?.dirty||!!manual?.dirty,pending:!!definition?.pending||!!manual?.pending};}});}
 activate(){if(this.active)return;this.active=true;this.register();}
 setAuthority(scope:string|null,forced=false){
  if(scope!==null&&!/^[a-f0-9]{64}$/.test(scope))throw new Error('自动化定义宿主身份范围无效');
  if(scope===this.authority&&!forced)return true;
  if(!forced&&!allowLeavingUnsavedWork())return false;
  this.generation++;this.current?.detach();this.manual?.detach();this.manual=null;this.unregister?.();this.unregister=null;this.current=null;this.authority=scope;this.scope=Symbol('automation-definition-owner');
  if(scope){const generation=this.generation;this.current=new AutomationDefinitionWriteSession(undefined,()=>{if(!this.active||generation!==this.generation||this.authority!==scope)throw new Error('身份已变化，旧自动化定义操作不可继续');});}
  if(scope){const generation=this.generation;this.manual=new ManualInventorySession(scope,()=>{if(!this.active||generation!==this.generation||this.authority!==scope)throw new Error('身份已变化，旧清单操作不可继续');});}
  this.register();this.emit();return true;
 }
 dispose(){this.generation++;this.current?.detach();this.manual?.detach();this.manual=null;this.unregister?.();this.unregister=null;this.current=null;this.authority=null;this.active=false;this.emit();}
}
