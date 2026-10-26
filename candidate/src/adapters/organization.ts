import type {
  OrganizationKind,
  OrganizationRecord,
  OrganizationRecordPage,
  ListOrganizationRecordsRequest,
  GetOrganizationRecordRequest,
  CreateOrganizationRecordRequest,
  UpdateOrganizationRecordRequest,
  MutateOrganizationRecordRequest,
  ServiceStatisticsRequest,
  ServiceStatistics,
  LocalTarget,
  MeetingIcsExport,
} from '../../shared/organization';
import { requestJson,ApiError } from './api';
import {organizationCommandCanonical,isOrganizationCommandOperation} from '../../shared/organization-command-outcome';
async function call<T>(action: string, input: unknown, signal?: AbortSignal): Promise<T> {
  // Snapshot before the asynchronous digest, so caller changes cannot alter wire bytes.
  const body=JSON.stringify(input),operation=`organization.${action}`;
  const mutation=!["list", "get", "serviceStatistics", "inspectTarget", "exportMeetingIcs"].includes(action);
  let expected;
  if(isOrganizationCommandOperation(operation)){
    const parsed=JSON.parse(body);
    if(typeof parsed?.idempotencyKey==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(parsed.idempotencyKey)){
      try{const canonical=organizationCommandCanonical(operation,parsed);const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));expected={operation,idempotencyKey:parsed.idempotencyKey,requestDigest:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};}
      catch{throw new ApiError({code:'INVALID_REQUEST',message:'无法准备有界机构操作，请检查内容与本地环境；本次未发送。',retryable:false},'not-sent');}
    }
  }
  return requestJson<T>(`/api/organization/${action}`, {method:'POST',headers:{'Content-Type':'application/json'},body,signal,...(mutation?{redirect:'error' as const}:{})},mutation,expected);
}
export const organizationApi = {
  list: <K extends OrganizationKind>(input: ListOrganizationRecordsRequest<K>, signal?: AbortSignal) =>
    call<OrganizationRecordPage<K>>('list', input, signal),
  get: <K extends OrganizationKind>(input: GetOrganizationRecordRequest<K>, signal?: AbortSignal) =>
    call<OrganizationRecord<K>>('get', input, signal),
  create: <K extends OrganizationKind>(input: CreateOrganizationRecordRequest<K>, signal?: AbortSignal) =>
    call<OrganizationRecord<K>>('create', input, signal),
  update: <K extends OrganizationKind>(input: UpdateOrganizationRecordRequest<K>, signal?: AbortSignal) =>
    call<OrganizationRecord<K>>('update', input, signal),
  remove: <K extends OrganizationKind>(input: MutateOrganizationRecordRequest<K>, signal?: AbortSignal) =>
    call<OrganizationRecord<K>>('remove', input, signal),
  restore: <K extends OrganizationKind>(input: MutateOrganizationRecordRequest<K>, signal?: AbortSignal) =>
    call<OrganizationRecord<K>>('restore', input, signal),
  serviceStatistics: (input: ServiceStatisticsRequest, signal?: AbortSignal) =>
    call<ServiceStatistics>('serviceStatistics', input, signal),
  inspectTarget: (input: { target: LocalTarget }, signal?: AbortSignal) =>
    call<{ target: LocalTarget; currentRevision: number; state: 'current' | 'changed'; localOnly: true }>(
      'inspectTarget',
      input,
      signal,
    ),
  exportMeetingIcs: (input: { id: string; expectedRevision?: number }, signal?: AbortSignal) =>
    call<MeetingIcsExport>('exportMeetingIcs', input, signal),
};

export type ServiceRecordProjection = {
  source: { id: string; revision: number; sha256: string; recordJson: string };
  customerPin: { organizationId: string; contactId: string | null; organizationRevision: number; contactRevision: number | null };
  projection: { customer: {organizationId: string; contactId: string | null}; kind: string; occurredAt: string; summary: string };
  existing: {id: string; revision: number; sourceRevision: number; archivedAt: string | null} | null;
  token: string;
  syntheticSourcePin: import('../../shared/reader-reference').ReaderSourcePin;
  warning: string;
};
async function bridgeCall<T>(action: string, input: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(`/api/service-reports/${action}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal}, action !== 'previewServiceRecord');
}
export const serviceRecordBridgeApi = {
  preview: (sourceId: string, signal?: AbortSignal) => bridgeCall<ServiceRecordProjection>('previewServiceRecord',{sourceId},signal),
  import: (input: {sourceId:string;token:string;status:string;sourcePin:ServiceRecordProjection['syntheticSourcePin'];reason:string}, signal?:AbortSignal) => bridgeCall<{activity:import('../../shared/service-reports').ServiceActivity;unchanged?:boolean}>('importServiceRecord',input,signal),
};
