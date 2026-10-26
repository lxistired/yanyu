import {parseWorkspaceCommandOutcome,type WorkspaceCommandOperation,type WorkspaceCommandOutcome} from '../../shared/workspace-command-outcome';
import {parseAutomationCommandOutcome,type AutomationCommandOperation,type AutomationCommandOutcome} from '../../shared/automation-command-outcome';
import {parseOrganizationCommandOutcome,type OrganizationCommandOperation,type OrganizationCommandOutcome} from '../../shared/organization-command-outcome';
import type {ErrorCode, ServiceError} from '../../shared/contracts';
import type {AudioUploadCapabilities} from '../../shared/audio-uploads';
import type {IntegrationCapability} from '../../shared/integration-capabilities';
export class ApiError extends Error {
  constructor(
    public detail: ServiceError,
    public readonly outcome?: 'read-failed' | 'not-sent' | 'unknown' | 'rejected',
    public readonly httpStatus?: number,
  ) {
    super(detail.message);
    this.name = 'ApiError';
  }
}
type OrganizationOutcomeExpectation={operation:OrganizationCommandOperation;idempotencyKey:string;requestDigest:string};
const trustedRejections=new WeakMap<ApiError,{outcome:OrganizationCommandOutcome;body:string}>();
/** Only the exact organization request that received the validated terminal fence can consume it. */
export function trustedOrganizationRejection(error:unknown,operation:string,body:string):ApiError|null {
 if(!(error instanceof ApiError))return null;const proof=trustedRejections.get(error);
 return proof&&proof.outcome.operation===`organization.${operation}`&&proof.body===body?error:null;
}
function organizationRejection(response:Response,payload:unknown,expected:OrganizationOutcomeExpectation,body:string):ApiError|null {
 if(!object(payload)||Object.keys(payload).sort().join(',')!=='commandOutcome,error'||!object(payload.error)||Object.keys(payload.error).sort().join(',')!=='code,message,retryable'||payload.error.retryable!==false)return null;
 const code=response.status===400?'INVALID_REQUEST':response.status===409?'CONFLICT':null;
 if(!code||payload.error.code!==code||payload.error.message!==(code==='INVALID_REQUEST'?'Invalid organization request':'Organization record conflict'))return null;
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??''))return null;
 const outcome=parseOrganizationCommandOutcome(payload.commandOutcome,expected);if(!outcome)return null;
 const error=new ApiError({code,retryable:false,message:code==='CONFLICT'?'原操作因记录变化已被明确拒绝；草稿未提交，请读取当前记录后核对。':'原操作已被明确拒绝；草稿未提交，请修正内容后重新保存。'},'rejected',response.status);
 trustedRejections.set(error,{outcome,body});return error;
}
type AutomationOutcomeExpectation={operation:AutomationCommandOperation;idempotencyKey:string;requestDigest:string};
const trustedAutomationRejections=new WeakMap<ApiError,{outcome:AutomationCommandOutcome;body:string}>();
/** Only the exact automation request that received the validated terminal fence can consume it. */
export function trustedAutomationRejection(error:unknown,operation:string,body:string):ApiError|null {
 if(!(error instanceof ApiError))return null;const proof=trustedAutomationRejections.get(error);
 return proof&&proof.outcome.operation===`automation.${operation}`&&proof.body===body?error:null;
}
function automationRejection(response:Response,payload:unknown,expected:AutomationOutcomeExpectation,body:string):ApiError|null {
 if(!object(payload)||Object.keys(payload).sort().join(',')!=='commandOutcome,error'||!object(payload.error)||Object.keys(payload.error).sort().join(',')!=='code,message,retryable'||payload.error.retryable!==false)return null;
 const code=response.status===400?'INVALID_REQUEST':response.status===409?'CONFLICT':null;
 if(!code||payload.error.code!==code||payload.error.message!==(code==='INVALID_REQUEST'?'Invalid automation request':'Automation record conflict'))return null;
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??''))return null;
 const outcome=parseAutomationCommandOutcome(payload.commandOutcome,expected);if(!outcome)return null;
 const error=new ApiError({code,retryable:false,message:code==='CONFLICT'?'原操作因记录变化已被明确拒绝；草稿未提交，请读取当前记录后核对。':'原操作已被明确拒绝；草稿未提交，请修正内容后重新保存。'},'rejected',response.status);
 trustedAutomationRejections.set(error,{outcome,body});return error;
}
type WorkspaceOutcomeExpectation={operation:WorkspaceCommandOperation;idempotencyKey:string;requestDigest:string};
const trustedWorkspaceRejections=new WeakMap<ApiError,{outcome:WorkspaceCommandOutcome;body:string}>();
/** Only the exact workspace request that received the validated terminal fence can consume it. */
export function trustedWorkspaceRejection(error:unknown,operation:string,body:string):ApiError|null {
 if(!(error instanceof ApiError))return null;const proof=trustedWorkspaceRejections.get(error);
 return proof&&proof.outcome.operation===`workspace.${operation}`&&proof.body===body?error:null;
}
function workspaceRejection(response:Response,payload:unknown,expected:WorkspaceOutcomeExpectation,body:string):ApiError|null {
 if(!object(payload)||Object.keys(payload).sort().join(',')!=='commandOutcome,error'||!object(payload.error)||Object.keys(payload.error).sort().join(',')!=='code,message,retryable'||payload.error.retryable!==false)return null;
 const code=response.status===400?'INVALID_REQUEST':response.status===409?'CONFLICT':null;
 if(!code||payload.error.code!==code||payload.error.message!==(code==='INVALID_REQUEST'?'Invalid workspace request':'Workspace record conflict'))return null;
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??''))return null;
 const outcome=parseWorkspaceCommandOutcome(payload.commandOutcome,expected);if(!outcome)return null;
 const error=new ApiError({code,retryable:false,message:code==='CONFLICT'?'原操作因记录变化已被明确拒绝；草稿未提交，请读取当前记录后核对。':'原操作已被明确拒绝；草稿未提交，请修正内容后重新保存。'},'rejected',response.status);
 trustedWorkspaceRejections.set(error,{outcome,body});return error;
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试';
}
export interface AppCapabilities {
  structuredData?: boolean;
  preservedFiles?: boolean;
  meetingReminders?: boolean;
  reportAttachments?: boolean;
  entityMaterials?: boolean;
  readerReferences?: boolean;
  pdfOriginalPages?: boolean;
  asrTaskManagement?: boolean;
  activityIndex?: boolean;
  preferences?: boolean;
  feedback?: boolean;
  readerPreferences?: boolean;
  workbenchHome?: boolean;
  usageLedger?: boolean;
  catalogSearch?: boolean;
  sourceConnectors?: boolean;
  serviceReadiness?: boolean;
  serviceReports?: boolean;
  serviceReportMail?: boolean;
  transcriptRevisions?: boolean;
  documentWorkspace?: boolean;
  conversationResearch?: boolean;
  reportExports?: boolean;
  audioUploads?: AudioUploadCapabilities;
  persistence: 'memory-only' | 'sqlite-local';
  mode: 'mock' | 'local';
  auth: 'fixed-demo-principal' | 'reject-all-unconfigured' | 'trusted-server-adapter';
  identityLabel?: string;
  retrieval?: 'fixtures' | 'synthetic-example' | 'portable' | 'trusted-server-adapter';
  model: 'mock' | 'unconfigured' | 'chat-completions-fixture' | 'registered';
  asr: 'mock' | 'unconfigured' | 'snapshot-fixture' | 'local';
  uploads: 'metadata-simulation' | 'local-audio' | 'local-files' | 'unavailable';
  privateAssets: boolean;
  plans: boolean;
  scheduledReports?: boolean;
  organization: boolean;
  workspace: boolean;
  automation: boolean;
  scheduler: {
    mode: 'running' | 'stopped' | 'manual';
    lastCheckedAt: string | null;
    lastError: string | null;
  };
}
const errorMessages: Record<ErrorCode, string> = {
  INVALID_REQUEST: '请求内容无效，请检查后重试',
  UNAUTHENTICATED: '当前会话不可用，请重新读取',
  FORBIDDEN: '当前操作不可用，请重新读取',
  NOT_FOUND: '请求的记录当前不可用，请刷新核对',
  CONFLICT: '记录已改变，请刷新核对后再操作',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  PROVIDER_ERROR: '服务响应无法确认，请检查本地服务',
  CANCELLED: '请求已取消',
  CURSOR_EXPIRED: '列表已改变，请从首页重新读取',
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const errorLimit = 16 * 1024;

function statusError(status?: number): Pick<ServiceError, 'code' | 'retryable'> {
  if (status === 400 || status === 422) return {code: 'INVALID_REQUEST', retryable: false};
  if (status === 401) return {code: 'UNAUTHENTICATED', retryable: false};
  if (status === 403) return {code: 'FORBIDDEN', retryable: false};
  if (status === 404 || status === 410) return {code: 'NOT_FOUND', retryable: false};
  if (status === 409) return {code: 'CONFLICT', retryable: false};
  if (status === 429) return {code: 'RATE_LIMITED', retryable: true};
  return {code: 'PROVIDER_ERROR', retryable: status === undefined || status === 408 || status >= 500};
}

function serverError(payload: unknown, status: number): Pick<ServiceError, 'code' | 'retryable'> {
  const error = object(payload) && object(payload.error) ? payload.error : null;
  if (error && typeof error.code === 'string' && Object.hasOwn(errorMessages, error.code) &&
    typeof error.message === 'string' && error.message.trim().length > 0 &&
    new TextEncoder().encode(error.message).length <= 2048 &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(error.message) &&
    typeof error.retryable === 'boolean') {
    // Remote messages, request IDs, bodies and exception causes are never echoed.
    return {code: error.code as ErrorCode, retryable: error.retryable};
  }
  return statusError(status);
}

function failure(
  value: Pick<ServiceError, 'code' | 'retryable'>,
  mutation: boolean,
  status?: number,
  notSent = false,
): ApiError {
  const outcome = mutation ? (notSent ? 'not-sent' : 'unknown') : 'read-failed';
  const message = notSent ? '请求已取消，未发送' : errorMessages[value.code] +
    (mutation ? '；提交结果未确认，请先刷新核对，勿重复提交' : '');
  return new ApiError({...value, message}, outcome, status);
}

async function boundedErrorBody(response: Response, signal?:AbortSignal|null): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let bytes = 0, body = '';
  const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try {
    while (true) {
      if(signal?.aborted){abort();return null;}
      const part = await reader.read();
      if(signal?.aborted){abort();return null;}
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > errorLimit) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      body += decoder.decode(part.value, {stream: true});
    }
    return JSON.parse(body + decoder.decode());
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    signal?.removeEventListener('abort',abort);
    reader.releaseLock();
  }
}

/** Byte limit applies before decoding/parsing automation definition DTOs. */
async function boundedAutomationDefinitionBody(response:Response,signal?:AbortSignal|null,maxBytes=4*1024*1024):Promise<unknown>{
 if(!response.body)throw Error('Missing definition response');const reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 try{while(true){if(signal?.aborted)throw Error('Definition read aborted');const part=await reader.read();if(signal?.aborted)throw Error('Definition read aborted');if(part.done)break;size+=part.value.byteLength;if(size>maxBytes){abort();throw Error('Definition response exceeds byte budget');}text+=decoder.decode(part.value,{stream:true});}if(signal?.aborted)throw Error('Definition read aborted');return JSON.parse(text+decoder.decode());}
 catch(error){abort();throw error;}finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}
}
/** One attempt only. POST is also used for reads, so callers mark mutations explicitly.
 * retryable is a service hint, never permission to repeat an unconfirmed mutation.
 * This normalizes the JSON/error envelope; each caller still owns its success DTO schema.
 */
export async function requestJson<T>(path: string, init: RequestInit = {}, mutation = false, organizationOutcome?: OrganizationOutcomeExpectation, automationOutcome?: AutomationOutcomeExpectation, automationDefinitionRead = false,workspaceOutcome?:WorkspaceOutcomeExpectation,workspaceRead=false): Promise<T> {
  if (init.signal?.aborted) {
    if (!mutation) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    throw failure({code: 'CANCELLED', retryable: false}, true, undefined, true);
  }
  const workspaceProofEnabled=Boolean(workspaceOutcome&&mutation&&init.method==='POST'&&typeof init.body==='string'&&path===`/api/${workspaceOutcome.operation.replace('.', '/')}`);
  const boundedWorkspace=workspaceProofEnabled||(workspaceRead&&!mutation&&init.method==='POST'&&['/api/workspace/list','/api/workspace/get','/api/workspace/previewDelete'].includes(path));
  const automationProofEnabled=Boolean(automationOutcome&&mutation&&init.method==='POST'&&typeof init.body==='string'&&path===`/api/${automationOutcome.operation.replace('.', '/')}`);
  const proofEnabled=Boolean(organizationOutcome&&mutation&&init.method==='POST'&&typeof init.body==='string'&&path===`/api/${organizationOutcome.operation.replace('.', '/')}`);
  let response: Response;
  try {
    response = await fetch(path, (proofEnabled||automationProofEnabled||boundedWorkspace)?{...init,redirect:'error'}:init);
  } catch {
    if (init.signal?.aborted && !mutation) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    throw failure(init.signal?.aborted ? {code: 'CANCELLED', retryable: false} : statusError(), mutation);
  }
  if((proofEnabled||automationProofEnabled||boundedWorkspace)&&(response.redirected||(response.url&&(()=>{try{return typeof location==='undefined'||new URL(response.url).href!==new URL(path,location.href).href;}catch{return true;}})())))throw failure({code:'PROVIDER_ERROR',retryable:false},mutation,response.status);
  if (!response.ok) {
    const payload=await boundedErrorBody(response,automationProofEnabled||automationDefinitionRead||boundedWorkspace?init.signal:undefined);
    if(proofEnabled&&!init.signal?.aborted){const rejected=organizationRejection(response,payload,organizationOutcome!,init.body as string);if(rejected)throw rejected;}
    if(automationProofEnabled&&!init.signal?.aborted){const rejected=automationRejection(response,payload,automationOutcome!,init.body as string);if(rejected)throw rejected;}
    if(workspaceProofEnabled&&!init.signal?.aborted){const rejected=workspaceRejection(response,payload,workspaceOutcome!,init.body as string);if(rejected)throw rejected;}
    throw failure(serverError(payload,response.status),mutation,response.status);
  }
  let value: unknown;
  try {
    const boundedDefinition=automationProofEnabled||(automationDefinitionRead&&!mutation&&init.method==='POST'&&['/api/automation/listSkills','/api/automation/listDataSources','/api/automation/listSchedules'].includes(path));
    value = boundedWorkspace?await boundedAutomationDefinitionBody(response,init.signal,path==='/api/workspace/list'?1024*1024:512*1024):boundedDefinition?await boundedAutomationDefinitionBody(response,init.signal):await response.json();
  } catch {
    if (init.signal?.aborted && !mutation) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    throw failure({code: init.signal?.aborted ? 'CANCELLED' : 'PROVIDER_ERROR', retryable: !init.signal?.aborted}, mutation, response.status);
  }
  // All selected APIs return an object or an array. An error-shaped 2xx reply is not success.
  if ((!object(value) && !Array.isArray(value)) || (object(value) && Object.hasOwn(value, 'error'))) {
    throw failure({code: 'PROVIDER_ERROR', retryable: false}, mutation, response.status);
  }
  return value as T;
}
export const api={ integrations: (signal?: AbortSignal) => requestJson<IntegrationCapability[]>('/api/integrations', { signal }) };
