import {
 MANUAL_INVENTORY_PROTOCOL, parseManualInventoryExecuteRequest, parseManualInventorySelection,
 type ManualInventoryCapabilities, type ManualInventoryPreview, type ManualInventorySelection,
 type ManualInventoryPreviewRequest, type ManualInventoryProof, type ManualInventoryHistoryPage,
 type ManualInventoryHistoryCursor, type ManualInventoryResultPayload, type ManualInventoryResultRequest,
} from '../../shared/manual-inventory-protocol';
import {manualInventoryApi,manualInventoryDigest,canonicalManualInventoryCommand,inventoryBinding,type ManualInventoryApi} from '../adapters/manual-inventory';
import {browserManualInventoryJournal,type ManualInventoryJournal,type ManualInventoryJournalRecord} from './manual-inventory-journal';

/** Host lifetime, not panel lifetime. No timers, automatic retry, result fetch or cancellation. */
export class ManualInventorySession {
 capabilities:ManualInventoryCapabilities|null=null;
 preview:ManualInventoryPreview|null=null;
 pending:ManualInventoryJournalRecord|null=null;
 proof:ManualInventoryProof|null=null;
 history:ManualInventoryHistoryPage|null=null;
 result:ManualInventoryResultPayload|null=null;
 resultTarget:ManualInventoryResultRequest|null=null;
 choices:Awaited<ReturnType<ManualInventoryApi['choices']>>|null=null;
 draft:{scheduleId:string;selection:ManualInventorySelection|null}={scheduleId:'',selection:null};
 private workBusy=false;private resultReadEpoch:number|null=null;
 get busy(){return this.workBusy||this.resultReadEpoch!==null;}
 get resultLoading(){return this.resultReadEpoch!==null;}
 get canCloseResult(){return !this.workBusy;}
 message='';historyError='';resultError='';choicesError='';recoveryBlocked=false;
 private detached=false;private invalidInstance=false;private resultEpoch=0;private listeners=new Set<()=>void>();
 constructor(readonly owner:string,private readonly assertOwner:()=>void,private readonly api:ManualInventoryApi=manualInventoryApi,private readonly journal:ManualInventoryJournal=browserManualInventoryJournal,private readonly uuid:()=>string=()=>crypto.randomUUID()){}
 get authorityInvalid(){return this.invalidInstance;}
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 private emit(){for(const f of this.listeners)f();}
 assertCurrent(){if(this.detached)throw Error('旧身份会话已停用');this.assertOwner();}
 private assertIdentity(){this.assertCurrent();if(this.invalidInstance)throw Error('自动化实例已变化，请刷新页面确认实例');if(!this.capabilities||this.capabilities.identityScope!==this.owner)throw Error('尚未确认当前身份和自动化实例');return this.capabilities;}
 unsavedState(){return {dirty:!!this.preview||!!this.draft.scheduleId||!!this.draft.selection,pending:!!this.pending&&!this.proof};}
 detach(){this.detached=true;this.resultEpoch++;this.resultReadEpoch=null;this.result=null;this.resultTarget=null;this.resultError='';this.choices=null;this.emit();}
 private async work(action:()=>Promise<void>,error:(message:string)=>void=(m)=>{this.message=m;}){
  if(this.busy||this.detached)return;this.workBusy=true;this.emit();
  try{this.assertCurrent();await action();}catch(e){if(!this.detached)error(e instanceof Error?e.message:'尚无法确认，请保留原操作。');}finally{this.workBusy=false;this.emit();}
 }
 async discover(){if(this.invalidInstance)return;return this.work(async()=>{
  const capabilities=await this.api.capabilities();this.assertCurrent();
  if(capabilities.identityScope!==this.owner){this.invalidInstance=true;this.recoveryBlocked=true;this.result=null;this.choices=null;this.preview=null;this.history=null;throw Error('当前身份已变化；旧会话已封闭，请刷新页面确认身份，原恢复记录未清除。');}
  if(this.capabilities&&this.capabilities.automationStoreScope!==capabilities.automationStoreScope){this.recoveryBlocked=true;this.invalidInstance=true;this.result=null;this.choices=null;this.preview=null;this.history=null;throw Error('自动化实例已变化；旧操作不能在新实例重试，请刷新页面确认实例，原恢复记录未清除。');}
  if(this.capabilities?.documentStoreScope!==capabilities.documentStoreScope||!capabilities.manualDocumentInventory.available)this.preview=null;
  this.capabilities=capabilities;this.result=null;this.choices=null;
  // Deliberately independent of available/documentStoreScope.
  if(!this.pending){try{this.pending=this.journal.read(this.owner,capabilities.automationStoreScope);this.recoveryBlocked=false;}catch(e){this.recoveryBlocked=true;throw e;}}
  this.message=this.pending?'已找到原操作；请明确查询回执，不会自动重试。':'请先查看历史，确认没有重复运行，再选择范围预览。';
 });}
 setDraft(scheduleId:string,selection:ManualInventorySelection|null){this.assertCurrent();if(this.busy||this.pending)throw Error('原操作核对完成前不能更换请求');const parsed=selection===null?null:parseManualInventorySelection(selection);if(selection!==null&&!parsed)throw Error('范围无效');this.draft={scheduleId,selection:parsed};this.preview=null;this.message='';this.emit();}
 async loadChoices(){return this.work(async()=>{const c=this.assertIdentity();if(!c.manualDocumentInventory.available||!c.documentStoreScope)throw Error('当前资料来源不可用；仍可查询原回执和历史。');this.choices=null;this.choicesError='';const choices=await this.api.choices(c.documentStoreScope);this.assertCurrent();this.choices=choices;},m=>{this.choicesError=m;});}
 async prepare(input:ManualInventoryPreviewRequest){return this.work(async()=>{
  const c=this.assertIdentity();if(this.pending||this.recoveryBlocked)throw Error('请先核对原操作');
  if(!c.manualDocumentInventory.available||!c.documentStoreScope||input.identityScope!==c.identityScope||input.automationStoreScope!==c.automationStoreScope||input.documentStoreScope!==c.documentStoreScope)throw Error('当前来源不允许新建预览');
  this.preview=null;this.message='';const preview=await this.api.preview(input);this.assertCurrent();this.preview=preview;
 });}
 cancelPreview(){this.assertCurrent();if(this.busy||this.pending)return;this.preview=null;this.draft={scheduleId:'',selection:null};this.message='仅放弃未发送的预览，没有取消服务器操作。';this.emit();}
 async executePreview(){return this.work(async()=>{
  const c=this.assertIdentity();if(this.pending||this.recoveryBlocked||!this.preview)throw Error('需先确认新的范围预览');
  if(!c.manualDocumentInventory.available||c.documentStoreScope!==this.preview.documentStoreScope||c.automationStoreScope!==this.preview.automationStoreScope||c.identityScope!==this.preview.identityScope)throw Error('来源能力已变化，请重新预览；未发送新操作');
  const envelope=parseManualInventoryExecuteRequest({protocol:MANUAL_INVENTORY_PROTOCOL,operationId:this.uuid(),...inventoryBinding(this.preview),inventoryDigest:this.preview.inventoryDigest});if(!envelope)throw Error('无法固定请求');
  const requestDigest=await manualInventoryDigest(canonicalManualInventoryCommand(envelope));this.assertCurrent();
  this.pending=Object.freeze({envelope,requestDigest});this.proof=null;this.preview=null;
  // Persist exact immutable envelope BEFORE invoking transport. Failure blocks the send.
  this.journal.save(this.pending);this.message='原请求已保存，正在发送；离开页面不会取消执行。';this.emit();
  const proof=await this.api.execute(envelope,requestDigest);this.assertCurrent();this.accept(proof);
 });}
 private accept(proof:ManualInventoryProof){
  if(!this.pending||proof.operationId!==this.pending.envelope.operationId||proof.requestDigest!==this.pending.requestDigest)throw Error('回执与原操作不一致');
  this.proof=proof;this.message=proof.state==='committed'?'已提交并保存一次固定历史清单。查看清单需要另行验证当前访问权限。':'原操作已明确拒绝，未创建清单；可保留回执并重新预览。';
 }
 async lookup(){return this.work(async()=>{
  const c=this.assertIdentity(),record=this.pending;if(!record||this.recoveryBlocked||record.envelope.automationStoreScope!==c.automationStoreScope)throw Error('原恢复请求不可用');
  const proof=await this.api.operation(record.envelope,record.requestDigest);this.assertCurrent();
  if(proof.state==='absent'){this.message='尚未找到回执；原请求仍可能提交。仅可明确查询或使用原封包重试，不能新建操作。';return;}this.accept(proof);
 });}
 async retryOriginal(){return this.work(async()=>{
  const c=this.assertIdentity(),record=this.pending;if(!record||this.proof||this.recoveryBlocked||record.envelope.automationStoreScope!==c.automationStoreScope)throw Error('没有可重试的未确定原操作');
  this.journal.save(record);this.message='明确重试同一操作标识和原封包；不是新运行。';this.emit();
  const proof=await this.api.execute(record.envelope,record.requestDigest);this.assertCurrent();this.accept(proof);
 });}
 beginNew(){this.assertCurrent();if(this.busy||!this.pending||!this.proof||this.recoveryBlocked)return;this.journal.remove(this.pending);this.pending=null;this.proof=null;this.preview=null;this.draft={scheduleId:'',selection:null};this.message='新的预览会创建独立运行，请先核对已有历史。';this.emit();}
 async loadHistory(cursor:ManualInventoryHistoryCursor|null=null){return this.work(async()=>{
  const c=this.assertIdentity();this.historyError='';const history=await this.api.history({protocol:MANUAL_INVENTORY_PROTOCOL,identityScope:c.identityScope,automationStoreScope:c.automationStoreScope,scheduleId:null,cursor,limit:25});this.assertCurrent();this.history=history;
 },m=>{this.historyError=m;});}
 async openResult(runId:string,resultId:string){
  if(this.busy||this.detached)return;
  // A dismissible read owns only this token, never the write/execution lock.
  const epoch=++this.resultEpoch;this.resultReadEpoch=epoch;
  try{
  const c=this.assertIdentity();this.result=null;this.resultError='';const target=Object.freeze({protocol:MANUAL_INVENTORY_PROTOCOL,identityScope:c.identityScope,automationStoreScope:c.automationStoreScope,runId,resultId});this.resultTarget=target;
  this.emit(); // Publish the first loading target before transport can remain pending.
  if(this.resultReadEpoch!==epoch||this.detached)return;
  const result=await this.api.result(target);
  if(this.resultReadEpoch!==epoch||this.detached)return;this.assertCurrent();
  if(this.pending&&this.proof?.state==='committed'&&this.proof.runId===runId&&(JSON.stringify(inventoryBinding(result.binding))!==JSON.stringify(inventoryBinding(this.pending.envelope))||result.inventoryDigest!==this.pending.envelope.inventoryDigest||result.completedAt!==this.proof.committedAt))throw Error('历史结果与已提交原请求不匹配；提交回执仍保留。');
  const historical=this.history?.items.find(i=>i.runId===runId&&i.resultId===resultId);
  if(historical&&(historical.completedAt!==result.completedAt||historical.scheduleId!==result.binding.scheduleId||historical.scheduleRevision!==result.binding.scheduleRevision||historical.skillId!==result.binding.skillId||historical.skillRevision!==result.binding.skillRevision))throw Error('历史结果与选中的历史引用不匹配；已提交历史不变。');
  this.result=result;
  }catch(e){if(this.resultReadEpoch===epoch&&!this.detached)this.resultError=e instanceof Error?e.message:'尚无法确认，请保留原操作。';}
  finally{if(this.resultReadEpoch===epoch){this.resultReadEpoch=null;this.emit();}}
 }
 closeResult(){
  if(!this.canCloseResult)return;
  // Invalidate delivery only: the underlying read is not aborted; writes are untouched.
  this.resultEpoch++;this.resultReadEpoch=null;this.result=null;this.resultTarget=null;this.resultError='';this.emit();
 }
}
