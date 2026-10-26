import {ServiceRecordProjectionSession} from './service-record-projection-session';
import {OrganizationWriteSession} from './organization-write-session';
import {allowLeavingUnsavedWork,registerUnsavedSession} from './unsaved-work';
/** Host scope is the fixed synthetic /api/demo/identity scope, not real authentication. */
export class OrganizationWriteHost {
 private authority:string|null=null;private generation=0;private active=false;
 private projectionCurrent:ServiceRecordProjectionSession|null=null;
 get projection(){return this.projectionCurrent;}
 private current:OrganizationWriteSession|null=null;private unregister:(()=>void)|null=null;
 private listeners=new Set<()=>void>();private token=Symbol('organization-recovery');private scope=Symbol('organization-owner');
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 get session(){return this.current;}
 get generationId(){return this.generation;}
 get identityScope(){return this.authority;}
 private emit(){for(const f of this.listeners)f();}
 private register(){if(this.active&&this.current)this.unregister=registerUnsavedSession({token:this.token,scope:this.scope,getState:()=>{const a=this.current?.unsavedState()??{dirty:false,pending:false},b=this.projectionCurrent?.unsavedState()??{dirty:false,pending:false};return {dirty:a.dirty||b.dirty,pending:a.pending||b.pending};}});}
 activate(){if(this.active)return;this.active=true;this.register();}
 setAuthority(scope:string|null,forced=false){
  if(scope!==null&&!/^[a-f0-9]{64}$/.test(scope))throw new Error('机构宿主身份范围无效');
  if(scope===this.authority&&!forced)return true;
  if(!forced&&!allowLeavingUnsavedWork())return false;
  this.generation++;this.projectionCurrent?.dispose();this.projectionCurrent=null;this.current?.detach();this.unregister?.();this.unregister=null;this.current=null;this.authority=scope;this.scope=Symbol('organization-owner');
  if(scope){const generation=this.generation;this.projectionCurrent=new ServiceRecordProjectionSession({binding:scope,epoch:generation},()=>this.active&&generation===this.generation&&this.authority===scope?{binding:scope,epoch:generation}:null);this.current=new OrganizationWriteSession(undefined,()=>{if(!this.active||generation!==this.generation||this.authority!==scope)throw new Error('身份已变化，旧机构操作不可继续');});}
  this.register();this.emit();return true;
 }
 dispose(){this.generation++;this.projectionCurrent?.dispose();this.projectionCurrent=null;this.current?.detach();this.unregister?.();this.unregister=null;this.current=null;this.authority=null;this.active=false;this.emit();}
}
