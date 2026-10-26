import type {
  WorkspaceKind,
  WorkspaceRecord,
  WorkspaceRecordPage,
  ListWorkspaceRecordsRequest,
  GetWorkspaceRecordRequest,
  CreateWorkspaceRecordRequest,
  UpdateWorkspaceRecordRequest,
  MutateWorkspaceRecordRequest,
  BatchDeleteWorkspaceRecordsRequest,
  WorkspaceMutationSummary,
  WorkspaceRecordIdentity,
  ImportWatchlistRequest,
  ImportWatchlistResult,
} from '../../shared/workspace-records';
import { requestJson,ApiError } from './api';
import {workspaceCommandCanonical,isWorkspaceCommandOperation} from '../../shared/workspace-command-outcome';
async function call<T>(action: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const body=JSON.stringify(input),operation=`workspace.${action}`;let expected;
  if(isWorkspaceCommandOperation(operation)){
    try{if(new TextEncoder().encode(body).length>32768)throw Error('Transport capacity');const parsed=JSON.parse(body);if(typeof parsed?.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(parsed.idempotencyKey))throw Error('key');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(workspaceCommandCanonical(operation,parsed)));
      expected={operation,idempotencyKey:parsed.idempotencyKey,requestDigest:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
    }catch{throw new ApiError({code:'INVALID_REQUEST',message:'工作区请求超过当前传输容量或无法安全准备，本次未发送；草稿仍保留。',retryable:false},'not-sent');}
  }
  return requestJson<T>(`/api/workspace/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  }, !["list", "get", "previewDelete"].includes(action),undefined,undefined,false,expected,["list","get","previewDelete"].includes(action));
}
export const workspaceApi = {
  list: <K extends WorkspaceKind>(input: ListWorkspaceRecordsRequest<K>, signal?: AbortSignal) =>
    call<WorkspaceRecordPage<K>>('list', input, signal),
  get: <K extends WorkspaceKind>(input: GetWorkspaceRecordRequest<K>, signal?: AbortSignal) =>
    call<WorkspaceRecord<K>>('get', input, signal),
  create: <K extends WorkspaceKind>(input: CreateWorkspaceRecordRequest<K>, signal?: AbortSignal) =>
    call<WorkspaceRecord<K>>('create', input, signal),
  update: <K extends WorkspaceKind>(input: UpdateWorkspaceRecordRequest<K>, signal?: AbortSignal) =>
    call<WorkspaceRecord<K>>('update', input, signal),
  remove: <K extends WorkspaceKind>(input: MutateWorkspaceRecordRequest<K>, signal?: AbortSignal) =>
    call<WorkspaceRecord<K>>('remove', input, signal),
  restore: <K extends WorkspaceKind>(input: MutateWorkspaceRecordRequest<K>, signal?: AbortSignal) =>
    call<WorkspaceRecord<K>>('restore', input, signal),
  previewDelete: (input: GetWorkspaceRecordRequest, signal?: AbortSignal) =>
    call<WorkspaceRecordIdentity[]>('previewDelete', input, signal),
  batchDelete: (input: BatchDeleteWorkspaceRecordsRequest, signal?: AbortSignal) =>
    call<WorkspaceMutationSummary[]>('batchDelete', input, signal),
  importWatchlist: (input: ImportWatchlistRequest, signal?: AbortSignal) =>
    call<ImportWatchlistResult>('importWatchlist', input, signal),
};
