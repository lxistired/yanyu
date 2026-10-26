import { MANUAL_PLAN_LIMITS, effectiveManualPlanLinks, manualPlanSourceKey } from '../../shared/manual-plans';
import type { ManualPlanRecord, ManualPlanFields, ManualPlanPage, ListManualPlans, ManualPlanState, ManualPlanSessionTarget, ManualPlanDocumentLink, ManualPlanSourceLink } from '../../shared/manual-plans';
import { ManualPlanClient, PlanRequestError, captureCommand, sourceLink, RAW_LIMIT, type CapturedCommand, type WriteOperation } from './manual-plan-client';
import {appendLocalPlanSummary, localPlanSummary, type LocalPlanSummaryInputs} from './local-plan-summary';
const empty = ():ManualPlanFields=>({title:'',objective:'',notes:'',targetDate:null});
const content = (r:ManualPlanRecord):ManualPlanFields=>({title:r.data.title,objective:r.data.objective,notes:r.data.notes,targetDate:r.data.targetDate});
/** Serialized payload bound, not a JavaScript heap measurement. Full previews/titles are never staged. */
export const MANUAL_PLAN_EDITOR_BYTES = 128 * 1024;
export type Editor = {key:string;record:ManualPlanRecord|null;draft:ManualPlanFields;dirty:boolean;materialBasket:ManualPlanSourceLink[]};
/** Ephemeral source fence only, never serialized into a draft or a write command. */
export type SimulatedPlanSummaryTarget = Readonly<{session:ManualPlanSession;editor:Editor;record:ManualPlanRecord;opening:number;planId:string;revision:number;storeScope:string|undefined}>;
const editorBytes=(editor:Editor)=>new TextEncoder().encode(JSON.stringify(editor)).length;
const unsaved=(editor:Editor|null)=>!!editor&&(editor.dirty||editor.materialBasket.length>0);
function boundedEditor(editor:Editor):Editor {if(editorBytes(editor)>MANUAL_PLAN_EDITOR_BYTES)throw Error('Editor payload limit');return editor;}

type Pending = {command:CapturedCommand; editor:Editor; opening:number; phase:'sending'|'uncertain'|'readback'|'reading'|'ready'; acknowledgedId?:string};
/** One instance per authenticated owner AND tenant. Do not reuse across identity changes.
 * Retain this instance across manager close/reopen; destroying it loses memory-only recovery.
 * At most eight unsaved editors (each serialized payload <=128 KiB) and one immutable pending command are retained.
 * Authored drafts retain their existing 32 KiB serialized bound; baskets contain at most 100 pointers.
 */
export class ManualPlanSession {
 editor:Editor|null=null; page:ManualPlanPage|null=null; filter:ListManualPlans={limit:MANUAL_PLAN_LIMITS.defaultLimit,offset:0}; previous:number[]=[];
 loading=false; detailLoading=false; error=''; listError=''; pending:Pending|null=null;
 private drafts=new Map<string,Editor>();private listeners=new Set<()=>void>();private mounted=false;private opening=0;private readGeneration=0;private listGeneration=0;private writing=false;
 constructor(readonly client=new ManualPlanClient(),private readonly key:()=>string=()=>crypto.randomUUID()){}
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};
 private emit(){for(const fn of this.listeners)fn();}
 attach(){this.mounted=true;this.opening++;this.detailLoading=false;this.loading=false;this.emit();void this.loadList();}
 detach(){this.mounted=false;this.opening++;this.readGeneration++;this.listGeneration++;}
 unsavedState=()=>({dirty:unsaved(this.editor)||this.drafts.size>0,pending:!!this.pending});
 hasUnsaved=()=>unsaved(this.editor)||this.drafts.size>0||!!this.pending;
 canLeave(confirm:(message:string)=>boolean):boolean{return !this.hasUnsaved()||confirm('是否保留当前用户内存会话中的草稿及未确定结果的操作，然后离开？离开不会取消写入。刷新页面或结束会话将丢失恢复信息。');}
 private stash():boolean {if(!unsaved(this.editor))return true;if(!this.drafts.has(this.editor!.key)&&this.drafts.size>=8){this.error='已保留八份草稿。请先查看或放弃一份，再离开当前编辑器。';this.emit();return false;}this.drafts.set(this.editor!.key,structuredClone(this.editor!));return true;}
 private move(confirm:(message:string)=>boolean){if(!this.canLeave(confirm)||!this.stash())return false;this.opening++;this.readGeneration++;this.detailLoading=false;this.error='';return true;}
 async open(key:string,confirm:(message:string)=>boolean){if(!this.move(confirm))return;const opening=this.opening,generation=++this.readGeneration;this.editor=null;this.detailLoading=true;this.emit();const cached=this.drafts.get(key);if(cached){this.editor=structuredClone(cached);this.detailLoading=false;this.emit();return;}try{const r=await this.client.get(key);if(!this.live(opening,generation))return;this.editor=boundedEditor({key,record:r,draft:content(r),dirty:false,materialBasket:[]});}catch{if(this.live(opening,generation))this.error='无法读取当前计划，未替换任何数据。';}finally{if(this.live(opening,generation)){this.detailLoading=false;this.emit();}}}
 newPlan(confirm:(message:string)=>boolean){if(!this.move(confirm))return;const cached=this.drafts.get('new');this.editor=cached?structuredClone(cached):{key:'new',record:null,draft:empty(),dirty:false,materialBasket:[]};this.emit();}
 edit(name:keyof ManualPlanFields,value:string){if(!this.editor||this.pending||this.detailLoading)return;if(!this.drafts.has(this.editor.key)&&this.drafts.size>=8){this.error='已保留八份草稿。请先放弃一份，再编辑其他计划。';this.emit();return;}const draft={...this.editor.draft,[name]:name==='targetDate'?(value||null):value};if(new TextEncoder().encode(JSON.stringify(draft)).length>RAW_LIMIT){this.error='草稿已达到内存大小限制（32 KiB），请缩短文本。';this.emit();return;}const next={...this.editor,draft,dirty:true};if(editorBytes(next)>MANUAL_PLAN_EDITOR_BYTES){this.error='编辑器数据已达到 128 KiB 内存载荷限制，原草稿和选择保持不变。';this.emit();return;}this.readGeneration++;this.editor=next;this.error='';this.emit();}
 captureSimulatedSummaryTarget():SimulatedPlanSummaryTarget|null {
  const editor=this.editor,record=editor?.record;
  if(!this.mounted||!editor||!record||this.pending||this.detailLoading||editor.dirty||record.deletedAt)return null;
  return Object.freeze({session:this,editor,record,opening:this.opening,planId:record.id,revision:record.revision,storeScope:record.storeScope});
 }
 /** Explicit local staging only. The user must still press the existing Save button. */
 stageSimulatedSummary(target:SimulatedPlanSummaryTarget,inputs:LocalPlanSummaryInputs):string|null {
  const editor=this.editor,record=editor?.record;
  if(!this.mounted||!editor||!record||target.session!==this||this.opening!==target.opening||editor!==target.editor||record!==target.record||record.id!==target.planId||record.revision!==target.revision||record.storeScope!==target.storeScope||this.pending||this.detailLoading||editor.dirty||record.deletedAt)return '当前计划、版本或草稿已改变，未追加摘要；不会覆盖新的草稿。请在当前计划重新打开模拟流程。';
  if(['completed','cancelled'].includes(record.data.state))return '已结束的计划需要明确重新打开后才能追加摘要。原备注和模拟输入保持不变。';
  if(!inputs.question.trim()||!inputs.scope.trim()||!inputs.output.trim())return '请先完整填写问题、范围及输出要求，并完成模拟流程。';
  const result=appendLocalPlanSummary(editor.draft.notes,localPlanSummary(record,inputs));
  if(!result.ok)return result.message;
  this.edit('notes',result.notes);
  return this.editor!==editor&&this.editor?.draft.notes===result.notes?null:(this.error||'摘要未追加；原备注和模拟输入保持不变。');
 }
 private live(opening:number,generation:number){return this.mounted&&this.opening===opening&&this.readGeneration===generation;}
 async loadList(){const generation=++this.listGeneration,request={...this.filter};this.loading=true;this.listError='';this.emit();try{const page=await this.client.list(request);if(!this.mounted||generation!==this.listGeneration)return;this.page=page;}catch{if(this.mounted&&generation===this.listGeneration){this.page=null;this.listError='无法读取匹配列表，不展示不完整的数量统计。';}}finally{if(this.mounted&&generation===this.listGeneration){this.loading=false;this.emit();}}}
 changeFilter(filter:ListManualPlans,confirm:(message:string)=>boolean){if(!this.canLeave(confirm))return;this.filter={...filter,offset:0,limit:MANUAL_PLAN_LIMITS.defaultLimit};this.previous=[];this.page=null;void this.loadList();}
 next(confirm:(message:string)=>boolean){if(this.loading||this.page?.nextOffset==null||!this.canLeave(confirm))return;this.previous.push(this.filter.offset??0);this.filter={...this.filter,offset:this.page.nextOffset};this.page=null;void this.loadList();}
 back(confirm:(message:string)=>boolean){if(this.loading||!this.previous.length||!this.canLeave(confirm))return;this.filter={...this.filter,offset:this.previous.pop()!};this.page=null;void this.loadList();}
 discard(confirm:(message:string)=>boolean){if(!this.editor||this.pending||!confirm(this.editor.materialBasket.length?'是否放弃这份未保存的草稿及待添加资料？已保存资料不受影响。':'是否放弃这份未保存的草稿？'))return;this.drafts.delete(this.editor.key);this.editor={...this.editor,draft:this.editor.record?content(this.editor.record):empty(),dirty:false,materialBasket:[]};this.error='';this.emit();}
 async refreshCurrent(confirm:(message:string)=>boolean){if(!this.editor||this.pending||!this.canLeave(confirm))return;if(!this.stash())return;const key=this.editor.key,scope=this.editor.record?.storeScope;if(key==='new')return;const opening=this.opening,generation=++this.readGeneration;this.detailLoading=true;this.emit();try{const r=await this.client.get(key,scope);if(!this.live(opening,generation))return; // Preserve dirty fields while updating the reviewed revision.
 this.editor=boundedEditor({key,record:r,draft:this.editor?.dirty?this.editor.draft:content(r),dirty:!!this.editor?.dirty,materialBasket:this.editor?.materialBasket??[]});this.error=unsaved(this.editor)?'已读取当前版本，草稿及待添加资料保持不变。请核对差异后再保存。':'';
 }catch{if(this.live(opening,generation))this.error='重新读取当前版本失败，草稿和已加载版本保持不变。';}finally{if(this.live(opening,generation)){this.detailLoading=false;this.emit();}}}

 private materialWritable(record:ManualPlanRecord){return this.mounted&&this.editor?.record===record&&!this.pending&&!this.detailLoading&&!this.editor.dirty&&!record.deletedAt&&!['completed','cancelled'].includes(record.data.state)&&!!record.storeScope;}
 /** Only accepted search callbacks may offer pointers. This never grants opening/source authority. */
 stageMaterial(link:ManualPlanSourceLink,record:ManualPlanRecord):boolean {
  if(!this.materialWritable(record))return false;const editor=this.editor!;
  if(!this.drafts.has(editor.key)&&this.drafts.size>=8){this.error='已保留八份草稿。请先查看或放弃一份，再选择其他计划的资料。';this.emit();return false;}
  let pointer:ManualPlanSourceLink;try{pointer=sourceLink(link);}catch{return false;}
  const key=manualPlanSourceKey(pointer),all=[...effectiveManualPlanLinks(record.data),...editor.materialBasket];
  if(all.some(item=>manualPlanSourceKey(item)===key))return true;
  if(new Set(all.map(manualPlanSourceKey)).size>=MANUAL_PLAN_LIMITS.materialLinks){this.error=`每个计划最多保存 ${MANUAL_PLAN_LIMITS.materialLinks} 份不同资料（含原有快捷入口和待添加项）；未丢弃或替换任何资料。`;this.emit();return false;}
  const next={...editor,materialBasket:[...editor.materialBasket,pointer]};if(editorBytes(next)>MANUAL_PLAN_EDITOR_BYTES){this.error='编辑器数据已达到 128 KiB 内存载荷限制，原草稿和选择保持不变。';this.emit();return false;}
  this.editor=next;this.error='';this.emit();return true;
 }
 unstageMaterial(link:ManualPlanSourceLink,record:ManualPlanRecord):boolean {
  if(!this.mounted||this.editor?.record!==record||this.pending||this.detailLoading)return false;
  const key=manualPlanSourceKey(link);this.editor={...this.editor,materialBasket:this.editor.materialBasket.filter(item=>manualPlanSourceKey(item)!==key)};if(!unsaved(this.editor))this.drafts.delete(this.editor.key);this.error='';this.emit();return true;
 }
 clearMaterials(confirm:(message:string)=>boolean){const editor=this.editor;if(!editor||!editor.materialBasket.length||this.pending||this.detailLoading||!confirm('是否清空待添加资料？已保存的资料、计划草稿和来源记录保持不变。'))return;if(this.editor!==editor||this.pending||this.detailLoading)return;this.editor={...editor,materialBasket:[]};if(!unsaved(this.editor))this.drafts.delete(editor.key);this.error='';this.emit();}
 async saveMaterials(){const editor=this.editor,record=editor?.record;if(!editor||!record||!editor.materialBasket.length||!this.materialWritable(record))return;await this.mutate('addMaterialLinks',undefined,{scope:record.storeScope!,materialLinks:editor.materialBasket});}
 async mutate(operation:WriteOperation,state?:ManualPlanState,association?:{scope:string;sessionLink?:ManualPlanSessionTarget|null;materialLink?:ManualPlanSourceLink|null;documentLink?:ManualPlanDocumentLink|null;materialLinks?:ManualPlanSourceLink[]}){if(!this.editor||this.pending||this.detailLoading)return;const e=this.editor,r=e.record;if(operation!=='create'&&!r)return;if(operation==='create'&&r)return;
 if((operation==='setMaterialLink'||operation==='setDocumentLink'||operation==='addMaterialLinks'||operation==='removeMaterialLink')&&(!r?.storeScope||association?.scope!==r.storeScope||r.deletedAt||['completed','cancelled'].includes(r.data.state)))return;
 if(operation!=='create'&&operation!=='update'&&operation!=='addMaterialLinks'&&e.materialBasket.length){this.error='请先添加所选资料或清空待添加列表，再更改计划状态、关联或已保存快捷入口。';this.emit();return;}
 if(operation!=='create'&&operation!=='update'&&e.dirty){this.error='请先保存或放弃草稿，再更改计划状态、关联或快捷入口。';this.emit();return;}
 try{const input=operation==='create'?e.draft:{id:r!.id,expectedRevision:r!.revision,...(operation==='update'?{patch:e.draft}:operation==='setState'?{state}:(operation==='setSessionLink'||operation==='setMaterialLink'||operation==='setDocumentLink'||operation==='addMaterialLinks'||operation==='removeMaterialLink')?association: {})};const command=captureCommand(operation,this.key(),input);this.pending={command,editor:structuredClone(e),opening:this.opening,phase:'sending'};this.error='';this.emit();await this.sendPending();}catch{this.error='请检查必填项、日期及 UTF-8 请求大小限制。草稿已保留。';this.emit();}}
 private async sendPending(){const p=this.pending;if(!p||this.writing||p.acknowledgedId)return;this.writing=true;p.phase='sending';this.emit();try{const ack=await this.client.write(p.command);if(this.pending!==p)return;p.acknowledgedId=ack.id;p.phase='readback';}catch(error){if(this.pending!==p)return;if(error instanceof PlanRequestError&&error.definite){if(this.mounted&&p.opening===this.opening)this.error=error.message;this.pending=null;}else{p.phase='uncertain';if(this.mounted&&p.opening===this.opening)this.error='写入结果尚不确定。仅可使用原操作标识和原文本重试，不要另建替代计划。';}}finally{this.writing=false;this.emit();}if(this.pending===p&&p.acknowledgedId)await this.readAcknowledged();}
 async retry(){if(this.pending?.phase==='uncertain')await this.sendPending();else if(this.pending?.acknowledgedId)await this.readAcknowledged();}
 private async readAcknowledged(){const p=this.pending;if(!p?.acknowledgedId||this.writing)return;this.writing=true;p.phase='reading';this.emit();const opening=this.opening;try{const current=await this.client.get(p.acknowledgedId,p.command.scope??p.editor.record?.storeScope);if(this.pending!==p)return;if(this.mounted&&opening===this.opening&&p.opening===this.opening){const saved=p.command.operation==='addMaterialLinks'?new Set((JSON.parse(p.command.body).materialLinks as ManualPlanSourceLink[]).map(manualPlanSourceKey)):new Set<string>();const materialBasket=p.editor.materialBasket.filter(link=>!saved.has(manualPlanSourceKey(link)));const next=boundedEditor({key:current.id,record:current,draft:content(current),dirty:false,materialBasket});this.drafts.delete(p.editor.key);this.editor=next;this.pending=null;this.error='';void this.loadList();}else{p.phase='ready';}}catch{if(this.pending===p){p.phase='readback';if(this.mounted&&p.opening===this.opening)this.error='写入已获确认，但重新读取当前数据失败。只能重试读取，不要再次提交写入。';}}finally{this.writing=false;this.emit();}}
 async reviewPending(confirm:(message:string)=>boolean){const p=this.pending;if(!p||this.writing||!this.move(confirm))return;this.editor=structuredClone(p.editor);p.opening=this.opening;this.emit();if(p.acknowledgedId)await this.readAcknowledged();}
 retainedKeys(){return [...this.drafts.keys()];}
}
