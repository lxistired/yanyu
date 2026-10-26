import {MANUAL_PLAN_LIMITS, type ManualPlanRecord} from '../../shared/manual-plans';
import {planText} from './manual-plan-client';

export type LocalPlanSummaryInputs = Readonly<{question:string;scope:string;output:string}>;
export type LocalPlanSummaryAppend = {ok:true;notes:string;addition:string}|{ok:false;message:string};

/** Deterministic, user-entered process log only. No clock, transport, model or result claim. */
export function localPlanSummary(plan:ManualPlanRecord, inputs:LocalPlanSummaryInputs):string {
 return [
  '【模拟流程摘要，非研究结论】',
  `计划：${plan.data.title}`,
  `已加载计划目标：${plan.data.objective}`,
  `本次模拟问题：${inputs.question}`,
  `范围与排除项：${inputs.scope}`,
  `预期输出与验收要求：${inputs.output}`,
  '流程记录：用户完成问题及范围澄清、清单审阅、独立批准、另行开始，并手动完成前端流程演示。',
  '未执行资料检索、模型推理或结论生成；没有创建会话或后台任务。',
  '待办：自行核对资料及待验证事项。本摘要不表示研究已完成。',
  '【模拟流程摘要结束】',
 ].join('\n');
}

/** Never trims or truncates any original text. Duplicate content is deliberately not re-appended. */
export function appendLocalPlanSummary(notes:string, summary:string):LocalPlanSummaryAppend {
 if(notes.includes(summary))return {ok:false,message:'相同的模拟摘要已在当前备注中，未重复追加。原备注和模拟输入保持不变。'};
 const addition=(notes?'\n\n':'')+summary, next=notes+addition;
 if(new TextEncoder().encode(next).length>MANUAL_PLAN_LIMITS.textBytes)return {ok:false,message:`追加后备注将超过 ${MANUAL_PLAN_LIMITS.textBytes} UTF-8 字节，未追加或截断任何内容。原备注及全部模拟输入保持不变；可返回修改模拟输入，或退出后整理备注再重试。`};
 try{planText(next,MANUAL_PLAN_LIMITS.textBytes);}catch{return {ok:false,message:'摘要包含计划备注不支持的字符，未追加或截断任何内容。原备注及全部模拟输入保持不变，请返回修改模拟输入。'};}
 return {ok:true,notes:next,addition};
}
