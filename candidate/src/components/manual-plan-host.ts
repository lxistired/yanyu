import {ManualPlanClient} from './manual-plan-client';
import {ManualPlanSession} from './manual-plan-session';
import {allowLeavingUnsavedWork,registerUnsavedSession} from './unsaved-work';
/** The host accepts only the verified /api/demo/identity identityScope, which binds
 * the backend's FIXED SYNTHETIC tenant+owner. This is not authentication or an
 * authorization boundary. Production identity must supply its own trusted scope.
 * Exactly one scope/session is retained; no identity cache or cross-owner retry. */
export class ManualPlanHost {
 private authority:string|null=null;private generation=0;private current:ManualPlanSession|null=null;
 private registration:(()=>void)|null=null;private active=false;private listeners=new Set<()=>void>();
 private readonly token=Symbol('manual-plan-host');private scope=Symbol('manual-plan-owner');
 constructor(private readonly transport:typeof fetch=fetch){}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 get session(){return this.current;}
 get identityScope(){return this.authority;}
 private emit(){for(const listener of this.listeners)listener();}
 private register(){if(!this.active||!this.current)return;this.registration=registerUnsavedSession({token:this.token,scope:this.scope,getState:()=>this.current?.unsavedState()??{dirty:false,pending:false}});}
 activate(){if(this.active)return;this.active=true;this.register();}
 /** User-requested changes prompt once. Forced authority loss never waits for a prompt. */
 setAuthority(scope:string|null,forced=false):boolean {
  if(scope!==null&&!/^[a-f0-9]{64}$/.test(scope))throw new Error('宿主身份范围无效');
  // A forced authority notification is a new generation even for the same scope.
  if(scope===this.authority&&!forced)return true;
  if(!forced&&!allowLeavingUnsavedWork())return false;
  this.generation++;this.current?.detach();this.registration?.();this.registration=null;
  this.authority=scope;this.current=null;this.scope=Symbol('manual-plan-owner');
  if(scope){const generation=this.generation;const assertAuthority=()=>{if(!this.active||generation!==this.generation||scope!==this.authority)throw new Error('身份已变化，旧操作不可继续');};this.current=new ManualPlanSession(new ManualPlanClient(this.transport,assertAuthority));}
  this.register();this.emit();return true;
 }
 dispose(){this.generation++;this.current?.detach();this.registration?.();this.registration=null;this.active=false;this.authority=null;this.current=null;this.emit();}
}
