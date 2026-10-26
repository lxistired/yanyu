import type {
  AutomationWrites,
  SkillView,
  DataSourceView,
  ScheduleRecord,
  ScheduleRunRecord,
  NotificationRecord,
} from '../../shared/automation';
import { requestJson,ApiError } from './api';
import {automationCommandCanonical,isAutomationCommandOperation} from '../../shared/automation-command-outcome';
async function call<T>(action: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const body=JSON.stringify(input),operation=`automation.${action}`;let expected;
  if(isAutomationCommandOperation(operation)){
    try {const parsed=JSON.parse(body);if(typeof parsed?.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(parsed.idempotencyKey))throw Error('key');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(automationCommandCanonical(operation,parsed)));
      expected={operation,idempotencyKey:parsed.idempotencyKey,requestDigest:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
    } catch {throw new ApiError({code:'INVALID_REQUEST',message:'无法准备有界自动化定义操作；本次未发送。',retryable:false},'not-sent');}
  }
  return requestJson<T>(`/api/automation/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  }, !["listSkills", "listDataSources", "listSchedules", "listRuns", "listNotifications", "getSkill", "getDataSource", "getSchedule", "getRun"].includes(action),undefined,expected,['listSkills','listDataSources','listSchedules'].includes(action));
}
const writeActions = [
  'createSkill',
  'updateSkill',
  'deleteSkill',
  'restoreSkill',
  'createDataSource',
  'updateDataSource',
  'deleteDataSource',
  'restoreDataSource',
  'createSchedule',
  'updateSchedule',
  'setScheduleState',
  'deleteSchedule',
  'restoreSchedule',
  'dispatchDue',
  'runNow',
  'retryRun',
  'cancelRun',
  'executeLocalRun',
  'markNotificationRead',
] as const;
type WriteAction = (typeof writeActions)[number];
type Writes = {
  [K in WriteAction]: (
    input: AutomationWrites[K]['input'],
    signal?: AbortSignal,
  ) => Promise<AutomationWrites[K]['result']>;
};
const writes = Object.fromEntries(
  writeActions.map((action) => [
    action,
    (input: unknown, signal?: AbortSignal) => call(action, input, signal),
  ]),
) as Writes;
export const automationApi = {
  ...writes,
  listSkills: (input: { includeDeleted?: boolean } = {}, signal?: AbortSignal) =>
    call<SkillView[]>('listSkills', input, signal),
  listDataSources: (input: { includeDeleted?: boolean } = {}, signal?: AbortSignal) =>
    call<DataSourceView[]>('listDataSources', input, signal),
  listSchedules: (input: { includeDeleted?: boolean } = {}, signal?: AbortSignal) =>
    call<ScheduleRecord[]>('listSchedules', input, signal),
  listRuns: (input: { scheduleId?: string } = {}, signal?: AbortSignal) =>
    call<ScheduleRunRecord[]>('listRuns', input, signal),
  listNotifications: (input: { unreadOnly?: boolean } = {}, signal?: AbortSignal) =>
    call<NotificationRecord[]>('listNotifications', input, signal),
  getSkill: (input: { id: string }, signal?: AbortSignal) => call<SkillView>('getSkill', input, signal),
  getDataSource: (input: { id: string }, signal?: AbortSignal) =>
    call<DataSourceView>('getDataSource', input, signal),
  getSchedule: (input: { id: string }, signal?: AbortSignal) =>
    call<ScheduleRecord>('getSchedule', input, signal),
  getRun: (input: { id: string }, signal?: AbortSignal) => call<ScheduleRunRecord>('getRun', input, signal),
};
