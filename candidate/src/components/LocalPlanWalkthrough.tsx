import {useReducer, useRef, useState} from 'react';
import type {ManualPlanRecord} from '../../shared/manual-plans';
import {useUnsavedWork} from './unsaved-work';
import {localPlanSummary, type LocalPlanSummaryInputs} from './local-plan-summary';

type Step='question'|'clarify'|'review'|'approved'|'running'|'result'|'cancelled';
type Inputs={question:string;scope:string;output:string};
type Flow={step:Step;inputs:Inputs};
type Action={type:'edit';field:keyof Inputs;value:string}|{type:'clarify'|'review'|'approve'|'start'|'finish'|'editQuestion'|'editClarification'|'reset'|'cancel'};
const limits:Record<keyof Inputs,number>={question:2000,scope:1200,output:1200};
const bounded=(value:string,limit:number)=>value.slice(0,limit).replace(/[\uD800-\uDBFF]$/,'');
const empty=(step:Step='question'):Flow=>({step,inputs:{question:'',scope:'',output:''}});
const complete=({question,scope,output}:Inputs)=>!!question.trim()&&!!scope.trim()&&!!output.trim();
// Approval belongs only to the current reviewed inputs. All edits leave approved state.
function reduceFlow(state:Flow,action:Action):Flow {
 switch(action.type){
  case 'edit':return {step:action.field==='question'?'question':'clarify',inputs:{...state.inputs,[action.field]:bounded(action.value,limits[action.field])}};
  case 'clarify':return state.step==='question'&&state.inputs.question.trim()?{...state,step:'clarify'}:state;
  case 'review':return state.step==='clarify'&&complete(state.inputs)?{...state,step:'review'}:state;
  case 'approve':return state.step==='review'&&complete(state.inputs)?{...state,step:'approved'}:state;
  case 'start':return state.step==='approved'&&complete(state.inputs)?{...state,step:'running'}:state;
  case 'finish':return state.step==='running'?{...state,step:'result'}:state;
  case 'editQuestion':return {...state,step:'question'};
  case 'editClarification':return {...state,step:'clarify'};
  case 'reset':return empty();
  case 'cancel':return empty('cancelled');
 }
}

type WalkthroughProps={plan:ManualPlanRecord;onExit:()=>void;onAppendSummary?:(inputs:LocalPlanSummaryInputs)=>string|null};
/** No transport, persistence, timer or model. Explicit return only stages the existing notes draft. */
export function LocalPlanWalkthrough({plan,onExit,onAppendSummary}:WalkthroughProps) {
 // The manager also invalidates on record/session replacement, busy state or dirty edits.
 return <Walkthrough key={JSON.stringify([plan.storeScope??null,plan.id,plan.revision])} plan={plan} onExit={onExit} onAppendSummary={onAppendSummary}/>;
}
function Walkthrough({plan,onExit,onAppendSummary}:WalkthroughProps) {
 const [{step,inputs},dispatch]=useReducer(reduceFlow,undefined,()=>empty());
 const [appendError,setAppendError]=useState('');const returned=useRef(false);
 const {question,scope,output}=inputs;
 const summary=localPlanSummary(plan,inputs),addition=(plan.data.notes?'\n\n':'')+summary;
 const terminal=['completed','cancelled'].includes(plan.data.state);
 const append=()=>{if(step!=='result'||returned.current||!onAppendSummary||terminal)return;returned.current=true;const error=onAppendSummary(inputs);if(error){returned.current=false;setAppendError(error);}else setAppendError('摘要已追加到备注草稿，尚未保存。');};
 useUnsavedWork(Object.values(inputs).some(value=>value.length>0));
 const edit=(field:keyof Inputs,value:string)=>dispatch({type:'edit',field,value});
 const exit=()=>{dispatch({type:'reset'});onExit();};
 const stages:[Step,string][]=[['question','输入问题'],['clarify','澄清范围与输出'],['review','审阅模拟清单'],['approved','批准后待开始'],['running','模拟执行状态'],['result','流程结果']];
 return <section aria-label="本地模拟研究流程">
 <h4>本地模拟研究流程 · 非 AI 研究</h4>
 <p>前端模拟：输入仅在当前页面内存中，不发送、不自动保存、不调用模型或调度；退出或切换计划即清除。完成后可明确追加摘要到备注草稿，再由你另行保存计划。</p>
 <p>来源：已加载计划「{plan.data.title}」· 版本 {plan.revision}（非实时版本）。不会自动改变原计划或建立会话关联。</p>
 <ol aria-label="模拟步骤">{stages.map(([value,label])=><li key={value} aria-current={step===value?'step':undefined}>{label}</li>)}</ol>
 {step==='question'&&<form onSubmit={event=>{event.preventDefault();dispatch({type:'clarify'});}}>
 <label>本次模拟问题<textarea maxLength={limits.question} value={question} onChange={event=>edit('question',event.target.value)}/></label>
 <button disabled={!question.trim()}>继续澄清范围与输出</button></form>}
 {step==='clarify'&&<form onSubmit={event=>{event.preventDefault();dispatch({type:'review'});}}>
 <p>本次问题：{question}</p><p>请自行说明范围和预期输出；不会由模型补全，也不会自动检索资料。</p>
 <label>本次范围与排除项<textarea maxLength={limits.scope} value={scope} onChange={event=>edit('scope',event.target.value)}/></label>
 <label>预期输出与验收要求<textarea maxLength={limits.output} value={output} onChange={event=>edit('output',event.target.value)}/></label>
 <button type="button" onClick={()=>dispatch({type:'editQuestion'})}>返回修改问题</button>
 <button disabled={!complete(inputs)}>审阅模拟计划</button></form>}
 {['review','approved','running','result'].includes(step)&&<section aria-label="本次模拟计划快照">
 <h5>{step==='review'?'待批准的模拟计划':'本次已批准的模拟计划'}</h5>
 <p>已保存目标：{plan.data.objective}</p>
 <dl><dt>问题</dt><dd>{question}</dd><dt>范围与排除项</dt><dd>{scope}</dd><dt>预期输出与验收要求</dt><dd>{output}</dd></dl>
 <p>固定前端检查清单（非模型生成）：</p>
 <ol><li>核对以上问题、范围、输出要求与已加载计划目标。</li><li>批准此清单，仅在本页标记为待开始，不执行任何任务。</li><li>另行点击开始，再由用户手动完成状态演示；不检索资料、不生成研究内容。</li></ol>
 </section>}
 {step==='review'&&<><p>请审阅以上完整上下文与清单。批准后仍需另行开始，修改输入须重新审阅并批准。</p>
 <button onClick={()=>dispatch({type:'editQuestion'})}>返回修改问题</button><button onClick={()=>dispatch({type:'editClarification'})}>返回修改澄清</button>
 <button onClick={()=>dispatch({type:'approve'})}>批准此模拟计划（不开始）</button></>}
 {step==='approved'&&<><p role="status">模拟计划已批准，尚未开始。没有后台任务，只有点击开始才进入模拟执行状态。</p>
 <button onClick={()=>dispatch({type:'editQuestion'})}>修改问题并撤销批准</button><button onClick={()=>dispatch({type:'editClarification'})}>修改澄清并撤销批准</button>
 <button onClick={()=>dispatch({type:'start'})}>开始本地模拟执行</button></>}
 {step==='running'&&<><p role="status">模拟执行中：等待你手动推进。没有后台任务，不会自动完成。</p><p>已核对问题与计划上下文；资料检索、模型推理和结论生成均未执行。</p><button onClick={()=>dispatch({type:'finish'})}>手动完成流程演示</button></>}
 {step==='result'&&<><p role="status">模拟流程已完成，不代表研究已完成。</p><h5>流程检查结果（非研究报告）</h5>
 <ul><li>问题、范围与输出澄清、清单审阅和独立批准步骤已走通。</li><li>批准没有启动任务；执行状态由用户另行开始并手动推进。</li><li>待办：自行核对资料及待验证事项。</li><li>原计划未修改，无结果或会话记录被保存。</li></ul>
 <label>将追加的完整文本（模拟流程摘要，非研究结论）<textarea readOnly value={addition} rows={16}/></label>
 <p>保留当前备注全部原文，在末尾追加以上全文（已有备注时以两个换行分隔）。追加只返回原计划编辑器，必须另点“保存计划”才会提交；取消或退出不会追加。</p>
 {terminal&&<p>已完成或已取消的计划需先返回并明确重新打开，才能追加备注草稿。</p>}
 {appendError&&<p role="alert">{appendError}</p>}
 {onAppendSummary&&<button disabled={terminal||returned.current} onClick={append}>追加模拟摘要到当前计划备注草稿</button>}
 <button onClick={()=>{setAppendError('');dispatch({type:'editClarification'});}}>返回修改模拟输入</button>
 <button onClick={()=>{setAppendError('');dispatch({type:'reset'});}}>清空并重新演示</button></>}
 {step==='cancelled'?<><p role="status">模拟已取消，问题、澄清和批准状态已清除。原计划未改变，没有后台任务需要停止。</p><button onClick={()=>dispatch({type:'reset'})}>重新开始模拟</button></>:<button onClick={()=>{setAppendError('');dispatch({type:'cancel'});}}>取消模拟并清空输入</button>}
 <button onClick={exit}>退出模拟并清空，返回计划</button>
 </section>;
}
