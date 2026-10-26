// Synthetic in-memory UI fixture only. Reload discards edits; never calls network.
const stamp='2026-10-15T00:00:00.000Z';
const record=(kind:string,id:string,data:any)=>({kind,id,data,revision:1,createdAt:stamp,updatedAt:stamp,deletedAt:null});
const workspaces=Array.from({length:35},(_,i)=>record('workspace',`ws-${i+1}`,{name:`合成工作区 ${String(i+1).padStart(2,'0')}`,parentId:null,description:'仅用于浏览器流程测试'}));
const watchlists=[record('watchlist','watch-1',{name:'合成自选分组',workspaceId:'ws-1',description:''})];
const organizations=Array.from({length:26},(_,i)=>record('organization',`org-${i+1}`,{name:`合成机构 ${String(i+1).padStart(2,'0')}`,parentId:null,category:'other',description:'虚构记录',website:'',tags:[],verification:'unverified'}));
const skills=[{...record('skill','skill-1',{name:'合成提醒技能',description:'仅在测试内存中编辑',handler:'local-notification',enabled:false}),availability:{status:'available',code:'local_only',detail:'Synthetic only',capabilities:['local-notification']}}];
const items:any[]=[];
export function populatedFixture(path:string,body:any):any|undefined {
 if(path==='/api/workspace/list'){
  let rows=body.kind==='workspace'?workspaces:body.kind==='watchlist'?watchlists:body.kind==='watchlist-item'?items:[];
  rows=rows.filter(r=>(!body.query||JSON.stringify(r.data).includes(body.query))&&(!body.workspaceId||r.kind==='workspace'&&r.id===body.workspaceId||r.data.workspaceId===body.workspaceId||r.kind==='watchlist-item')&&(!body.watchlistId||r.data.watchlistId===body.watchlistId));
  const offset=body.offset||0,limit=body.limit||20;
  return {items:rows.slice(offset,offset+limit),total:rows.length,offset,nextOffset:offset+limit<rows.length?offset+limit:null};
 }
 if(path==='/api/organization/list'){const rows=body.kind==='organization'?organizations:[]; const offset=body.offset||0,limit=body.limit||200;return {items:rows.slice(offset,offset+limit),nextOffset:offset+limit<rows.length?offset+limit:null};}
 if(path==='/api/workspace/get')return [...workspaces,...watchlists,...items].find(r=>r.id===body.id);
 if(path==='/api/workspace/importWatchlist'){
  const created:any[]=[],skipped:any[]=[];
  for(const item of body.items){const old=items.find(r=>r.data.symbol===item.symbol&&r.data.market===item.market);if(old)skipped.push({symbol:item.symbol,market:item.market,existingId:old.id});else{const r=record('watchlist-item',`item-${items.length+1}`,{...item,watchlistId:body.watchlistId});items.push(r);created.push(r);}}
  return {created,skipped};
 }
 if(path==='/api/automation/listSkills')return skills;
 if(path==='/api/automation/getSkill')return skills.find(r=>r.id===body.id);
 if(path==='/api/automation/updateSkill'){const r=skills.find(r=>r.id===body.id);if(r){r.data={...r.data,...body.patch};r.revision++;return r;}}
 return undefined;
}
