import {WorkspaceWriteSession} from './workspace-write-session';
import {allowLeavingUnsavedWork,registerUnsavedSession} from './unsaved-work';
/** Host scope is the fixed synthetic /api/demo/identity scope, not real authentication. */
export class WorkspaceWriteHost {
 private authority:string|null=null;private generation=0;private active=false;
 private current:WorkspaceWriteSession|null=null;private unregister:(()=>void)|null=null;
 private listeners=new Set<()=>void>();private token=Symbol('workspace-recovery');private scope=Symbol('workspace-owner');
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 get session(){return this.current;}
 get generationId(){return this.generation;}
 get identityScope(){return this.authority;}
 private emit(){for(const f of this.listeners)f();}
 private register(){if(this.active&&this.current)this.unregister=registerUnsavedSession({token:this.token,scope:this.scope,getState:()=>this.current?.unsavedState()??{dirty:false,pending:false}});}
 activate(){if(this.active)return;this.active=true;this.register();}
 setAuthority(scope:string|null,forced=false){
  if(scope!==null&&!/^[a-f0-9]{64}$/.test(scope))throw new Error('工作区宿主身份范围无效');
  if(scope===this.authority&&!forced)return true;
  if(!forced&&!allowLeavingUnsavedWork())return false;
  this.generation++;this.current?.detach();this.unregister?.();this.unregister=null;this.current=null;this.authority=scope;this.scope=Symbol('workspace-owner');
  if(scope){const generation=this.generation;this.current=new WorkspaceWriteSession(undefined,()=>{if(!this.active||generation!==this.generation||this.authority!==scope)throw new Error('身份已变化，旧工作区操作不可继续');});}
  this.register();this.emit();return true;
 }
 dispose(){this.generation++;this.current?.detach();this.unregister?.();this.unregister=null;this.current=null;this.authority=null;this.active=false;this.emit();}
}
