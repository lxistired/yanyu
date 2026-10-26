import {createPlanConversationIntent,currentPlanConversationSource,cleanConversationDestination,type PlanConversationIntent,type PlanConversationSource} from './plan-conversation-handoff';
import {MANUAL_PLAN_LIMITS} from '../../shared/manual-plans';
import type {PlanMaterialReturn} from './ManualPlanManager';
import {researchTranscriptReturn, type ResearchTranscriptReturn, researchDocumentReturn, type ResearchDocumentReturn} from './local-research-search';
import {recentTranscriptReturn, type RecentTranscriptReturn} from './recent-transcript-return';
import {recentDocumentReturn, type RecentDocumentReturn} from './recent-document-return';
import {createMeetingOpenIntent, type MeetingOpenIntent, type MeetingAgendaBinding} from './meeting-open-intent';
import {meetingOpenSelection, type MeetingOpenSelection} from './meeting-open-selection';
import {createPdfOpenIntent, type PdfOpenIntent} from './pdf-open-intent';
import {pdfOpenSelection, type PdfOpenSelection} from './pdf-open-selection';
import {WorkspaceHostView} from './WorkspaceHostView';
import type {WorkspaceWriteHost} from './workspace-write-host';
import {AutomationDefinitionHostView} from './AutomationDefinitionHostView';
import type {AutomationDefinitionWriteHost} from './automation-definition-write-host';
import {allowLeavingUnsavedWork, subscribeUnsavedHistory, writeUnsavedHistory, unsavedHistoryDisplayUrl, unsavedHistoryEntryKey} from './unsaved-work';
import {useLayoutEffect, useRef, useState, useEffect, useMemo, useSyncExternalStore} from 'react';
import {PrivateCompanyData} from './PrivateCompanyData';
import {LocalResearchSearch} from './LocalResearchSearch';
import {LocalRecentMaterials} from './LocalRecentMaterials';
import {LocalDocuments} from './LocalDocuments';
import {LocalTranscription} from './LocalTranscription';
import {LayoutGrid} from 'lucide-react';
import {ResearchAppShell} from './ResearchAppShell';
import type {ResearchPage, ResearchNavigationItem} from './research-experience-types';
import {WorkspaceManager} from './WorkspaceManager';
import {OrganizationHostView} from './OrganizationHostView';
import type {OrganizationWriteHost} from './organization-write-host';
import {OrganizationManager} from './OrganizationManager';
import {ManualPlanHostView} from './ManualPlanHostView';
import type {ManualPlanHost} from './manual-plan-host';
import {LocalMeetingAgenda} from './LocalMeetingAgenda';
import {agendaReturnContext, agendaHistoryReturn, type AgendaReturnContext} from './local-meeting-agenda';
import {ServiceReportsEntry} from './ServiceReportsEntry';
import {AutomationManager} from './AutomationManager';
import {FeedbackSettingsEntry} from './FeedbackSettingsEntry';
import {HelpContent} from './HelpContent';
import {IntegrationCapabilities} from './IntegrationCapabilities';
import {pages, researchTranscriptDestination, readOrdinaryRoute, ordinaryRouteUrl, routeKey, OrdinaryRequestLifetime, type OrdinaryRoute, type SettingsPanel} from './ordinary-navigation';
import './ordinary-navigation.css';
const names: Record<ResearchPage,string> = {home:'首页',research:'资料检索',companies:'公司',chat:'研究对话',roadshow:'路演',files:'音频转写',documents:'文档',reader:'阅读器',materials:'资料',tasks:'近期本地资料',usage:'服务报告',workspace:'工作区',organization:'机构',calendar:'本地会议日程',planner:'手工研究计划',automation:'自动化',scheduled:'定时研究',settings:'服务与接入'};
const navigation: ResearchNavigationItem[] = pages.map(id=>({id,name:names[id],icon:LayoutGrid}));
const panels: [SettingsPanel,string][] = [['overview','设置概览'],['capabilities','接入能力'],['feedback','我的反馈'],['help','使用说明']];
const ordinaryPages: ResearchPage[] = ['home','research','chat','tasks','companies','files','documents','workspace','organization','calendar','planner','usage','automation','settings'];
/** Bounded presentation composition. No production identity, server or full-App bootstrap. */
export function OrdinaryNavigationShell({lifetime, identityScope = null, manualPlanHost,organizationWriteHost,automationDefinitionWriteHost,workspaceWriteHost}: {lifetime: OrdinaryRequestLifetime; identityScope?: string | null; manualPlanHost?:ManualPlanHost;organizationWriteHost?:OrganizationWriteHost;automationDefinitionWriteHost?:AutomationDefinitionWriteHost;workspaceWriteHost?:WorkspaceWriteHost}) {
 const [state,setState] = useState(()=>({route:readOrdinaryRoute(new URL(unsavedHistoryDisplayUrl())),epoch:lifetime.epoch}));
 // Exactly one recent -> selected transcript -> accepted history return, in memory.
 // Fresh mounts, ordinary navigation, replacement and identity changes do not restore.
 const recentTicket=useRef<{key:string;context:RecentTranscriptReturn;identity:string|null}|null>(null);
 const recentRestore=useRef<RecentTranscriptReturn|null>(null);
 // Independent sibling ticket: recent documents -> selected PDF -> immediate accepted Back.
 const documentTicket=useRef<{key:string;context:RecentDocumentReturn;identity:string|null}|null>(null);
 const documentRestore=useRef<RecentDocumentReturn|null>(null);
 const researchTicket=useRef<{key:string;context:ResearchDocumentReturn;identity:string|null}|null>(null);
 const researchRestore=useRef<ResearchDocumentReturn|null>(null);
 const planTicket=useRef<{key:string;context:PlanMaterialReturn;identity:string|null}|null>(null);
 const planRestore=useRef<PlanMaterialReturn|null>(null);
 const conversationIntent=useRef<PlanConversationIntent|null>(null);
 const currentWorkspaceHost=useRef(workspaceWriteHost);currentWorkspaceHost.current=workspaceWriteHost;
 const currentPlanHost=useRef(manualPlanHost);currentPlanHost.current=manualPlanHost;
 const currentPlan=(context:PlanMaterialReturn)=>currentPlanHost.current?.session===context.session&&context.session.editor?.record===context.record&&!context.record.deletedAt&&!context.session.pending&&!context.session.detailLoading;
 const capturePlan=(context:Pick<PlanMaterialReturn,'initialDocumentReturn'|'initialTranscriptReturn'>):PlanMaterialReturn|null=>{
  const session=manualPlanHost?.session,record=session?.editor?.record;
  return route.page==='planner'&&!route.unknown&&session&&record&&!record.deletedAt&&!session.pending&&!session.detailLoading?{session,record,...context}:null;
 };
 const pdfIntent=useRef<PdfOpenIntent|null>(null);
 const meetingIntent=useRef<MeetingOpenIntent|null>(null);
 const meetingAgendaContext=useRef<AgendaReturnContext|undefined>(undefined);
 const meetingTicket=useRef<{key:string;context:AgendaReturnContext;binding:MeetingAgendaBinding|null;identity:string|null}|null>(null);
 const meetingRestore=useRef<AgendaReturnContext|undefined>(undefined);
 const subscribeHost=useMemo(()=>organizationWriteHost?.subscribe??(()=>()=>{}),[organizationWriteHost]);
 const hostGeneration=useSyncExternalStore(subscribeHost,()=>organizationWriteHost?.generationId??0,()=>organizationWriteHost?.generationId??0);
 const currentHost=useRef(organizationWriteHost);currentHost.current=organizationWriteHost;
 const meetingBinding=useMemo<MeetingAgendaBinding|null>(()=>{
  const host=organizationWriteHost,session=host?.session,scope=host?.identityScope;
  if(!host||!session||!scope||!session.available)return null;
  const binding:MeetingAgendaBinding=Object.freeze({identityScope:scope,hostGeneration,session,isCurrent:()=>currentHost.current===host&&host.session===session&&host.identityScope===scope&&host.generationId===hostGeneration&&session.available});
  return binding;
 },[organizationWriteHost,hostGeneration]);
 useLayoutEffect(()=>{meetingAgendaContext.current=undefined;meetingTicket.current=null;meetingRestore.current=undefined;if(meetingIntent.current)meetingIntent.current.pending=false;meetingIntent.current=null;},[organizationWriteHost,hostGeneration]);
 const mounted=useRef(false);
 const currentIdentity=useRef(identityScope);currentIdentity.current=identityScope;
 const previousIdentity=useRef(identityScope);
 useLayoutEffect(()=>{if(previousIdentity.current!==identityScope){conversationIntent.current=null;meetingAgendaContext.current=undefined;meetingTicket.current=null;meetingRestore.current=undefined;recentTicket.current=null;recentRestore.current=null;documentTicket.current=null;documentRestore.current=null;researchTicket.current=null;researchRestore.current=null;planTicket.current=null;planRestore.current=null;if(pdfIntent.current)pdfIntent.current.pending=false;if(meetingIntent.current)meetingIntent.current.pending=false;meetingIntent.current=null;previousIdentity.current=identityScope;}},[identityScope]);
 useLayoutEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;meetingTicket.current=null;meetingAgendaContext.current=undefined;meetingRestore.current=undefined;conversationIntent.current=null;documentTicket.current=null;documentRestore.current=null;researchTicket.current=null;researchRestore.current=null;planTicket.current=null;planRestore.current=null;};},[]);
 const focus = useRef<HTMLHeadingElement>(null);
 const [workspaceId,setWorkspaceId] = useState('');
 const {route,epoch}=state;
 // Consume a remembered range on re-entry; later unrelated visits must not resurrect it.
 useLayoutEffect(()=>{meetingAgendaContext.current=undefined;meetingRestore.current=undefined;},[route.page,epoch]);
 const [historyIssue,setHistoryIssue]=useState<string | null>(null);
 const accept = (next: OrdinaryRoute, restore:RecentTranscriptReturn|null=null, documents:RecentDocumentReturn|null=null, research:ResearchDocumentReturn|null=null, plan:PlanMaterialReturn|null=null, meeting:AgendaReturnContext|undefined=undefined) => {meetingTicket.current=null;meetingAgendaContext.current=undefined;meetingRestore.current=meeting;conversationIntent.current=null;recentTicket.current=null;recentRestore.current=restore;documentTicket.current=null;documentRestore.current=documents;researchTicket.current=null;researchRestore.current=research;planTicket.current=null;planRestore.current=plan;if(meetingIntent.current)meetingIntent.current.pending=false;meetingIntent.current=null;if(pdfIntent.current)pdfIntent.current.pending=false;pdfIntent.current=null;setState({route:next,epoch:lifetime.advance()});};
 useEffect(()=>subscribeUnsavedHistory(()=>{
  const next=readOrdinaryRoute(new URL(location.href)),ticket=recentTicket.current;
  const restore=next.page==='tasks'&&!next.unknown&&ticket&&ticket.identity===currentIdentity.current&&ticket.key===unsavedHistoryEntryKey()?ticket.context:null;
  const document=documentTicket.current;
  const restoreDocuments=next.page==='tasks'&&!next.unknown&&document&&document.identity===currentIdentity.current&&document.key===unsavedHistoryEntryKey()?document.context:null;
  const research=researchTicket.current;
  const restoreResearch=next.page==='research'&&!next.unknown&&research&&research.identity===currentIdentity.current&&research.key===unsavedHistoryEntryKey()?research.context:null;
  const plan=planTicket.current;
  const restorePlan=next.page==='planner'&&!next.unknown&&plan&&plan.identity===currentIdentity.current&&plan.key===unsavedHistoryEntryKey()&&currentPlan(plan.context)?plan.context:null;
  const meeting=meetingTicket.current;
  const restoreMeeting=meeting&&meeting.identity===currentIdentity.current&&(!meeting.binding||meeting.binding.isCurrent())?agendaHistoryReturn(meeting,next.page,next.unknown,unsavedHistoryEntryKey()):undefined;
  accept(next,restore,restoreDocuments,restoreResearch,restorePlan,restoreMeeting);
 },setHistoryIssue),[lifetime]);
 const navigate=(page:ResearchPage,panel:SettingsPanel='overview',replace=false)=>{
  const next={page,panel}; if(!replace && routeKey(next)===routeKey(route) && !pdfIntent.current?.pending && !meetingIntent.current?.pending) return; if(!allowLeavingUnsavedWork())return; const url=ordinaryRouteUrl(next,location.href);
  if(!writeUnsavedHistory(url,replace))return;
  accept(next);
 };
 const navigatePlanConversation=(source:PlanConversationSource)=>{
  const host=workspaceWriteHost,planHost=manualPlanHost;
  const sourceCurrent=()=>mounted.current&&currentIdentity.current===identityScope&&currentPlanHost.current===planHost&&planHost?.session===source.session&&planHost.identityScope===identityScope&&currentWorkspaceHost.current===host&&host?.identityScope===identityScope&&currentPlanConversationSource(source);
  if(route.page!=='planner'||route.unknown||!host||!sourceCurrent()){setHistoryIssue('当前计划或工作区身份已变化，未进入其他会话。');return;}
  let targetEpoch=-1;
  const intent:PlanConversationIntent|null=createPlanConversationIntent(source,host,sourceCurrent,()=>mounted.current&&conversationIntent.current===intent&&lifetime.epoch===targetEpoch);
  if(!intent){setHistoryIssue('请先返回工作区处理保留的编辑器、草稿或待确认操作，再进入计划关联会话。原内容保持不变。');return;}
  if(!allowLeavingUnsavedWork()||!sourceCurrent()||!cleanConversationDestination(intent.session)||intent.session.draftVersion!==intent.draftVersion)return;
  const next:OrdinaryRoute={page:'chat',panel:'overview'};
  try{if(!writeUnsavedHistory(ordinaryRouteUrl(next,location.href)))return;}
  catch{setHistoryIssue('无法切换到关联会话，计划与草稿已保留。');return;}
  accept(next);targetEpoch=lifetime.epoch;conversationIntent.current=intent;
 };
 const returnToSourcePlan=()=>{
  const source=conversationIntent.current?.source;
  if(!source||currentPlanHost.current?.session!==source.session||!currentPlanConversationSource(source)){setHistoryIssue('来源计划上下文已变化，请从手工研究计划重新选择；不会自动打开另一份计划。');return;}
  navigate('planner');
 };
 const navigateResearchTranscript=(destination:string, context?:RecentTranscriptReturn|ResearchTranscriptReturn)=>{
  const url=researchTranscriptDestination(destination,location.href);
  const preference=researchTranscriptReturn(context);
  const plan=preference?capturePlan({initialTranscriptReturn:preference}):null;
  const planKey=plan?unsavedHistoryEntryKey():null;
  if(!url || currentIdentity.current!==identityScope || !allowLeavingUnsavedWork() || currentIdentity.current!==identityScope || (plan&&!currentPlan(plan)))return;
  const key=context&&route.page==='tasks'?unsavedHistoryEntryKey():null;
  const snapshot=key?recentTranscriptReturn(context as RecentTranscriptReturn):null;

  if(!writeUnsavedHistory(url))return;
  // Always accept the selected URL, even when page/panel routeKey is unchanged.
  // LocalTranscription reads transcriptJob on mount; epoch owns that selection.
  accept(readOrdinaryRoute(url));
  if(plan&&planKey&&preference?.transcriptStoreId===url.searchParams.get('transcriptStoreId')&&currentPlan(plan)&&currentIdentity.current===identityScope)planTicket.current={key:planKey,context:plan,identity:identityScope};
  if(key&&snapshot&&snapshot.transcriptStoreId===url.searchParams.get('transcriptStoreId')&&currentIdentity.current===identityScope)recentTicket.current={key,context:snapshot,identity:currentIdentity.current};
 };
 const navigateResearchPdf=(value:PdfOpenSelection, context?:RecentDocumentReturn|ResearchDocumentReturn)=>{
  const selection=pdfOpenSelection(value);
  const preference=researchDocumentReturn(context);
  const plan=preference?capturePlan({initialDocumentReturn:preference}):null;
  const planKey=plan?unsavedHistoryEntryKey():null;
  const current=()=>mounted.current&&currentIdentity.current===identityScope&&lifetime.epoch===epoch;
  if(!selection||!current()||!allowLeavingUnsavedWork()||!current()||(plan&&!currentPlan(plan)))return;
  const key=context&&route.page==='tasks'&&!route.unknown?unsavedHistoryEntryKey():null;
  const snapshot=key?recentDocumentReturn(context):null;
  const researchKey=context&&route.page==='research'&&!route.unknown?unsavedHistoryEntryKey():null;
  const researchSnapshot=researchKey?researchDocumentReturn(context):null;

  const next:OrdinaryRoute={page:'documents',panel:'overview'};
  try{if(!writeUnsavedHistory(ordinaryRouteUrl(next,location.href)))return;}
  catch{setHistoryIssue('无法切换到所选 PDF，当前页面与草稿已保留；请稍后重试。');return;}
  // The write already succeeded. Identity/lifetime drift cannot pretend to roll back history.
  if(!current()){accept(readOrdinaryRoute(new URL(location.href)));setHistoryIssue('所选 PDF 的当前范围已变化，请返回资料列表重新核对。');return;}
  meetingTicket.current=null;meetingAgendaContext.current=undefined;meetingRestore.current=undefined;
  if(meetingIntent.current)meetingIntent.current.pending=false;meetingIntent.current=null;
  if(pdfIntent.current)pdfIntent.current.pending=false;
  recentTicket.current=null;recentRestore.current=null;
  documentTicket.current=null;documentRestore.current=null;researchTicket.current=null;researchRestore.current=null;planTicket.current=null;planRestore.current=null;
  const nextEpoch=lifetime.advance();
  const intent:PdfOpenIntent|null=createPdfOpenIntent(selection,nextEpoch,()=>mounted.current&&currentIdentity.current===identityScope&&lifetime.epoch===nextEpoch&&pdfIntent.current===intent);
  pdfIntent.current=intent;setState({route:next,epoch:nextEpoch});
  if(key&&snapshot&&snapshot.documentStoreId===selection.storeScope&&mounted.current&&currentIdentity.current===identityScope)documentTicket.current={key,context:snapshot,identity:identityScope};
  if(plan&&planKey&&preference?.documentStoreId===selection.storeScope&&currentPlan(plan)&&currentIdentity.current===identityScope)planTicket.current={key:planKey,context:plan,identity:identityScope};
  if(researchKey&&researchSnapshot&&researchSnapshot.documentStoreId===selection.storeScope&&mounted.current&&currentIdentity.current===identityScope)researchTicket.current={key:researchKey,context:researchSnapshot,identity:identityScope};
 };
 const navigateMeeting=(value:MeetingOpenSelection)=>{
  if(route.page!=='calendar'||route.unknown||lifetime.epoch!==epoch||currentIdentity.current!==identityScope)return;
  const sourceKey=unsavedHistoryEntryKey(),context=agendaReturnContext(meetingAgendaContext.current);
  const selection=meetingOpenSelection(value),binding=meetingBinding,host=organizationWriteHost;
  if(!selection||!binding||!host)return;
  const session=binding.session;
  let approvedVersion:number,approvedToken:string|null;
  const eligible=()=>{try{return binding.isCurrent()&&selection.identityScope===binding.identityScope&&selection.hostGeneration===binding.hostGeneration&&!session.pending&&!session.draftRetentionIncomplete&&!host.projection?.unsavedState().pending;}catch{return false;}};
  if(!eligible()){setHistoryIssue('请先核对当前机构操作；所选会议尚未打开，现有草稿与待确认操作已保留。');return;}
  try{approvedVersion=session.editorVersion;approvedToken=session.editor?.token??null;}catch{return;}
  const approvalCurrent=()=>{try{return eligible()&&session.editorVersion===approvedVersion&&(session.editor?.token??null)===approvedToken;}catch{return false;}};
  if(!allowLeavingUnsavedWork())return;
  if(!approvalCurrent())return;
  const next:OrdinaryRoute={page:'organization',panel:'overview'};
  try{if(!writeUnsavedHistory(ordinaryRouteUrl(next,location.href)))return;}
  catch{setHistoryIssue('无法切换到所选会议，当前页面与草稿已保留；请稍后重试。');return;}
  // History already changed: never pretend rollback if authority/draft changed inside it.
  if(!approvalCurrent()){accept(readOrdinaryRoute(new URL(location.href)));setHistoryIssue('所选会议的当前范围或草稿已变化，请返回议程重新核对。');return;}
  if(pdfIntent.current)pdfIntent.current.pending=false;pdfIntent.current=null;
  if(meetingIntent.current)meetingIntent.current.pending=false;meetingIntent.current=null;
  recentTicket.current=null;recentRestore.current=null;
  documentTicket.current=null;documentRestore.current=null;researchTicket.current=null;researchRestore.current=null;planTicket.current=null;planRestore.current=null;
  const nextEpoch=lifetime.advance();
  const intent:MeetingOpenIntent|null=createMeetingOpenIntent(selection,nextEpoch,binding,approvedVersion,approvedToken,()=>mounted.current&&currentIdentity.current===identityScope&&lifetime.epoch===nextEpoch&&meetingIntent.current===intent);
  meetingTicket.current=intent&&sourceKey&&context?{key:sourceKey,context,binding,identity:identityScope}:null;meetingAgendaContext.current=undefined;meetingRestore.current=undefined;
  meetingIntent.current=intent;setState({route:intent?next:readOrdinaryRoute(new URL(location.href)),epoch:nextEpoch});
 };
 useLayoutEffect(()=>{focus.current?.focus();},[epoch]);
 const allowed=!route.unknown && ordinaryPages.includes(route.page);
 return <ResearchAppShell activePage={route.page} navigation={navigation} currentModeLabel={route.page==='companies'?'私有历史数据 · 只读':'本地功能 · 合成工作区'} onNavigate={page=>navigate(page)} onOpenHelp={()=>navigate('settings','help')}
 statusSlot={<p className="ordinary-boundary">公司页保留机构数据只读接口及合成测试；本公开包不提供真实私有来源或接入配置，默认不可用；不属于合成工作区。工作区、机构、服务报告经同源 HTTP 保存到本地 SQLite。固定合成身份，非生产登录；自动化定义可保存在本地；通用任务与定时执行未接通，通知投递未接通。{automationDefinitionWriteHost ? '专用手动文档清单须取得有效身份与手动会话，并核验当前来源；来源未知或不可用时不能新建。可用时须先预览范围，再明确确认保存一次元数据清单；不读取正文、不调用 AI、不发送通知。' : '此入口未提供专用手动清单。'}其他外部功能不可用。本地检索已接入未删除的文档与转写，分别查询、计数和分页；完整跨来源目录、统一排名与外部检索未接入。本地文档支持 TXT、MD、PDF 上传与纯文本预览；本地音频转写提供离线 CPU 模型运行入口；当前模型可用性与真实推理效果尚未验收；本地已保存会议可在本地会议日程中只读查看；外部会议与提醒未接通。手工研究计划是独立原创的本地手工记录，可明确关联一个已有普通会话，并保留原有单份快捷入口；可明确选择并批量保存最多 {MANUAL_PLAN_LIMITS.materialLinks} 份不同文档或转写资料（含原有快捷入口，打开时核对当前资料，非冻结引用或资料归属证明）。不自动执行研究、AI、提醒或调度。邮件、反馈、密钥和发布未接入。</p>}>
  {historyIssue && <p role="alert">{historyIssue}</p>}
  <div className="ordinary-tools" aria-label="页面历史"><button onClick={()=>history.back()}>后退</button><button onClick={()=>history.forward()}>前进</button><button onClick={()=>navigate(route.page,route.panel,true)}>替换当前路由并刷新</button></div>
  <h1 ref={focus} tabIndex={-1}>{route.unknown ? '未知目的地' : names[route.page]}</h1>
  <p className="ordinary-policy">转写校对、PDF 批注、工作区、机构和自动化表单修改在应用内离开前会提示未保存内容；已知应用历史中取消离开可继续编辑；未知历史记录无法保证恢复地址，会保留当前草稿并提示。浏览器刷新或关闭可能不显示提示，请先保存。反馈页面离开后仍会丢弃未保存输入。工作区选择在本次访问内保留；报告入口保持挂载，由其自身范围与路由生命周期管理草稿。</p>
  {!allowed ? <section role="status"><h2>此功能在当前组合中不可用</h2><p>{route.unknown ?? names[route.page]} 尚未接入。不会跳转到完整应用或调用外部服务。</p><button onClick={()=>navigate('home','overview',true)}>替换为首页</button></section> : null}
  {allowed && route.page==='home' && <section className="ordinary-home"><h2>从这里继续</h2><p>工作、协作与服务入口位于同一个研究空间。工作区、机构与服务报告使用合成记录；公司页保留独立的机构数据只读入口与合成测试，真实私有接入在本公开包中未提供。</p>{(['research','chat','tasks','companies','files','documents','workspace','organization','calendar','planner','automation','usage','settings'] as const).map(page=><button key={page} onClick={()=>navigate(page)}>{names[page]}</button>)}</section>}
  {allowed && route.page==='research' && <LocalResearchSearch key={`research-${epoch}`} initialDocumentReturn={researchRestore.current} onNavigate={navigateResearchTranscript} onOpenPdf={navigateResearchPdf}/>}
  {allowed && route.page==='tasks' && <LocalRecentMaterials key={`recent-materials-${epoch}`} initialTranscriptReturn={recentRestore.current} initialDocumentReturn={documentRestore.current} onNavigate={navigateResearchTranscript} onOpenPdf={navigateResearchPdf}/>}
  {allowed && route.page==='companies' && <PrivateCompanyData key={`private-companies-${epoch}`}/>}
  {allowed && route.page==='documents' && <LocalDocuments key={`documents-${epoch}`} pdfOpenIntent={pdfIntent.current}/>}
  {allowed && route.page==='files' && <LocalTranscription key={`transcription-${epoch}`}/>}
  {workspaceWriteHost?<WorkspaceHostView host={workspaceWriteHost} visible={allowed&&(route.page==='workspace'||route.page==='chat')} entryMode={route.page==='chat'?'manual-conversation':'workspace'} initialWorkspaceId={route.page==='chat'?undefined:workspaceId} onWorkspaceChange={id=>setWorkspaceId(id??'')} onOpenWorkspace={()=>navigate('workspace')} conversationIntent={route.page==='chat'?conversationIntent.current:null} onReturnToPlan={returnToSourcePlan}/>:allowed&&route.page==='workspace'?<WorkspaceManager key={`workspace-${epoch}`} initialWorkspaceId={workspaceId} onWorkspaceChange={id=>setWorkspaceId(id??'')}/>:allowed&&route.page==='chat'?<p role="status">本地手工会话暂不可用：宿主未提供受信任的固定合成身份。未连接 AI，不会生成回复。</p>:null}
  {allowed && route.page==='calendar' && <LocalMeetingAgenda key={`calendar-${epoch}`} initialContext={meetingRestore.current} onRememberContext={context=>{meetingAgendaContext.current=agendaReturnContext(context);}} onManageOrganizations={()=>{
    const key=unsavedHistoryEntryKey(),context=agendaReturnContext(meetingAgendaContext.current),before=lifetime.epoch;
    navigate('organization');
    if(lifetime.epoch!==before&&key&&context&&currentIdentity.current===identityScope)meetingTicket.current={key,context,binding:meetingBinding,identity:identityScope};
  }} binding={meetingBinding} onOpenMeeting={navigateMeeting}/>}
  {allowed && route.page==='planner' && (manualPlanHost?<ManualPlanHostView key={`manual-plan-${epoch}`} host={manualPlanHost} initialMaterialReturn={planRestore.current} onOpenConversation={navigatePlanConversation} onClose={()=>navigate('home')} onNavigateMaterial={navigateResearchTranscript} onOpenPdf={navigateResearchPdf}/>:<p role="status">手工研究计划暂不可用：宿主未提供受信任的固定合成身份。</p>)}
  {organizationWriteHost?<OrganizationHostView host={organizationWriteHost} visible={allowed&&route.page==='organization'} routeEpoch={epoch} meetingOpenIntent={meetingIntent.current}/>:allowed&&route.page==='organization'?<OrganizationManager key={`organization-${epoch}`}/>:null}
  {automationDefinitionWriteHost?<AutomationDefinitionHostView host={automationDefinitionWriteHost} visible={allowed&&route.page==='automation'}/>:allowed && route.page==='automation' && <><p role="status">自动化定义已接入本地 SQLite；刷新和后端重启后保留。通用任务与定时执行未接通；此入口未提供专用手动清单。</p><AutomationManager key={`automation-${epoch}`} schedulerActive={false} definitionsOnly/></>}
  <div hidden={!allowed || route.page!=='usage'}><p role="status">服务报告：当前使用本地测试身份，未接入真实登录或企业认证。可明确选择已上传资料，经核验后引用，并从活动或月报打开引用文本；也保留合成示例。手工活动和月报保存在本地；月报支持 JSON、CSV、静态 HTML 下载。报告提交可核对已保存结果；机构记录的待确认提交只在本次访问内保留，刷新后不保证恢复。机构记录须逐条预览并明确选择状态与来源，月报仅汇总已保存活动。AI、邮件等外部服务未接通；本地验证不等于浏览器或设备验收。</p><ServiceReportsEntry available={identityScope !== null} mailAvailable={false} identityScope={identityScope} visible={allowed && route.page==='usage'} routeEpoch={epoch}/></div>
  {allowed && route.page==='settings' && <section key={`settings-${epoch}`}><nav className="ordinary-settings" aria-label="服务与接入页面">{panels.map(([panel,label])=><button key={panel} aria-current={panel===route.panel?'page':undefined} onClick={()=>navigate('settings',panel)}>{label}</button>)}</nav>
   {route.panel==='overview' && <p>可查看接入能力与使用说明。服务报告仅使用此隔离演示服务器的固定合成所有者范围；没有真实登录。反馈、邮件和外部服务不可用。</p>}
   {route.panel==='capabilities' && <IntegrationCapabilities source="synthetic"/>}
   {route.panel==='feedback' && <FeedbackSettingsEntry available={false} expectedOwnerScope={null} lifecycleKey={`ordinary-${epoch}`}/>}
   {route.panel==='help' && <HelpContent capabilities={null} capabilityState="not-read" onNavigate={page=>navigate(page)} onClose={()=>queueMicrotask(()=>{if(lifetime.epoch===epoch)navigate('settings')})}/>}
  </section>}
 </ResearchAppShell>;
}
