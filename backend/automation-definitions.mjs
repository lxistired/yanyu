// Bounded HTTP adaptation only. Exact domain methods remain unchanged.
// Execution methods do not exist in the extracted class and have no HTTP routes.
export function definitionBridge(domain,store,AdapterError){
 const out={};
 const fields=(input,allowed)=>{if(Object.keys(input).some(k=>!allowed.includes(k)))throw new AdapterError('INVALID_REQUEST','Unexpected definition field')};
 const view=value=>Array.isArray(value)?value.map(view):value&&value.availability?{...value,availability:{status:'unavailable',code:'definition_only',detail:'定义已保存，通用任务与定时执行未接通；未授予通用连接或执行权限。',capabilities:[]}}:value;
 for(const op of ['createSkill','updateSkill','deleteSkill','restoreSkill','createDataSource','updateDataSource','deleteDataSource','restoreDataSource','createSchedule','updateSchedule','setScheduleState','deleteSchedule','restoreSchedule'])out[op]=(ctx,input)=>view(domain[op](ctx,input));
 for(const op of ['listSkills','listDataSources','listSchedules'])out[op]=(ctx,input)=>{fields(input,['includeDeleted']);return view(domain[op](ctx,input.includeDeleted??false))};
 for(const op of ['getSkill','getDataSource','getSchedule'])out[op]=(ctx,input)=>{fields(input,['id']);return view(domain[op](ctx,input.id))};
 // Read actual persisted rows, never synthesize successful/queued execution.
 out.listRuns=(ctx,input)=>{fields(input,['scheduleId']);if(input.scheduleId!==undefined&&typeof input.scheduleId!=='string')throw new AdapterError('INVALID_REQUEST','Invalid schedule ID');return store.read(ctx,tx=>tx.list('schedule-run').filter(r=>r.data?.manualInventory?.protocol!=='manual-inventory-v1'&&(!input.scheduleId||r.data.scheduleId===input.scheduleId)))};
 out.listNotifications=(ctx,input)=>{fields(input,['unreadOnly']);if(input.unreadOnly!==undefined&&typeof input.unreadOnly!=='boolean')throw new AdapterError('INVALID_REQUEST','Invalid unread flag');return store.read(ctx,tx=>tx.list('notification').filter(r=>!input.unreadOnly||!r.data.readAt))};
 return Object.freeze(out);
}
