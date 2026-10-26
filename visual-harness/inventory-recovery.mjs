import {validateScheduleCadence} from '../scheduler/cadence.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const workspaceId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const fail = message => {throw Error(message);};
const plain = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== [...keys].sort().join()) fail('清单恢复记录格式不受支持');
};
export function recoveryKey(scope) {
  if (typeof scope !== 'string' || !uuid.test(scope)) fail('本地清单恢复范围不可用');
  return 'yanyu:inventory-recovery:v1:' + scope;
}
function validateDraft(value) {
  plain(value, ['kind', 'delay', 'time', 'timezone', 'weekdays', 'workspace', 'folder']);
  if (!['once', 'daily', 'weekly'].includes(value.kind)) fail('清单草稿周期无效');
  // Incomplete and invalid form inputs are drafts too; do not normalize them.
  for (const field of ['delay', 'time', 'timezone', 'workspace', 'folder']) {
    if (typeof value[field] !== 'string' || value[field].length > 200) fail('清单草稿字段过长或无效');
  }
  if (!Array.isArray(value.weekdays) || value.weekdays.length > 7 || new Set(value.weekdays).size !== value.weekdays.length || value.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) fail('清单草稿运行日无效');
  return structuredClone(value);
}
function validateCommand(value) {
  plain(value, ['id', 'idempotencyKey', 'handler', 'scope', 'cadence']);
  if (!uuid.test(value.id) || value.idempotencyKey !== value.id || value.handler !== 'document-inventory-snapshot') fail('待确认清单请求标识无效');
  plain(value.scope, ['workspaceId', 'folderId']);
  if (value.scope.workspaceId !== null && (typeof value.scope.workspaceId !== 'string' || !workspaceId.test(value.scope.workspaceId))) fail('待确认清单工作区无效');
  if (value.scope.folderId !== null && (typeof value.scope.folderId !== 'string' || !uuid.test(value.scope.folderId))) fail('待确认清单文件夹无效');
  validateScheduleCadence(value.cadence);
  return structuredClone(value);
}
function requireMatchingDraft(draft, command) {
  if ((draft.workspace || null) !== command.scope.workspaceId || (draft.folder || null) !== command.scope.folderId || draft.kind !== command.cadence.kind) fail('清单草稿与待确认请求范围不一致');
  if (draft.kind === 'once' && (!draft.delay.trim() || !Number.isInteger(Number(draft.delay)) || Number(draft.delay) < 5 || Number(draft.delay) > 86400)) fail('待确认清单草稿延迟无效');
  const cadence = validateScheduleCadence(draft.kind === 'once'
    ? {kind: 'once', at: command.cadence.at, timezone: draft.timezone.trim()}
    : draft.kind === 'daily' ? {kind: 'daily', time: draft.time, timezone: draft.timezone.trim()}
    : {kind: 'weekly', time: draft.time, timezone: draft.timezone.trim(), weekdays: draft.weekdays});
  if (JSON.stringify(cadence) !== JSON.stringify(validateScheduleCadence(command.cadence))) fail('清单草稿与待确认请求时间不一致');
}
export function matchesInventoryCommand(schedule, command) {
  try {
    const expected = validateCommand(command), actual = schedule?.definition;
    return actual?.handler === expected.handler && schedule.id === expected.id && ['active', 'paused', 'completed', 'cancelled'].includes(schedule.state)
      && actual?.scope?.workspaceId === expected.scope.workspaceId && actual?.scope?.folderId === expected.scope.folderId
      && JSON.stringify(validateScheduleCadence(actual.cadence)) === JSON.stringify(validateScheduleCadence(expected.cadence));
  } catch {return false;}
}

/** Synchronous write-ahead journal. Nothing here sends requests or starts plans. */
export class InventoryRecovery {
  constructor(storage, scope, initialDraft) {
    this.storage = storage;
    this.scope = scope;
    this.key = recoveryKey(scope);
    this.restored = false;
    this.value = {draft: validateDraft(initialDraft), pending: null};
    const raw = storage.getItem(this.key);
    if (raw === null) return;
    if (typeof raw !== 'string' || raw.length > 16384) fail('清单恢复记录超出大小限制');
    let record;
    try {record = JSON.parse(raw);} catch {fail('清单恢复记录无法读取，原记录仍保留');}
    plain(record, ['version', 'scope', 'draft', 'pending']);
    if (record.version !== 1 || record.scope !== scope) fail('清单恢复记录属于其他数据范围或版本');
    const draft = validateDraft(record.draft);
    let pending = null;
    if (record.pending !== null) {
      plain(record.pending, ['command', 'uncertain']);
      if (record.pending.uncertain !== true) fail('待确认清单请求格式无效');
      pending = {command: validateCommand(record.pending.command), uncertain: true};
      requireMatchingDraft(draft, pending.command);
    }
    this.value = {draft, pending};
    this.restored = true;
  }
  snapshot() {return structuredClone(this.value);}
  write(next) {
    const value = {version: 1, scope: this.scope, draft: validateDraft(next.draft), pending: next.pending ? {command: validateCommand(next.pending.command), uncertain: true} : null};
    if (value.pending) requireMatchingDraft(value.draft, value.pending.command);
    const raw = JSON.stringify(value);
    if (raw.length > 16384) fail('清单恢复记录超出大小限制');
    // A failed write must not advance the in-memory command or erase the last record.
    this.storage.setItem(this.key, raw);
    if (this.storage.getItem(this.key) !== raw) fail('浏览器未保留清单恢复记录，未发送新请求');
    this.value = structuredClone(next);
    return this.snapshot();
  }
  edit(draft) {
    if (this.value.pending) fail('请先确认上次创建结果，再修改清单草稿');
    return this.write({draft: validateDraft(draft), pending: null});
  }
  begin(command) {
    if (this.value.pending) return this.snapshot();
    return this.write({draft: this.value.draft, pending: {command: validateCommand(command), uncertain: false}});
  }
  markUncertain() {
    if (!this.value.pending) return this.snapshot();
    this.value.pending.uncertain = true;
    return this.snapshot(); // Already written as uncertain before dispatch.
  }
  rejectFirst() {
    if (!this.value.pending || this.value.pending.uncertain) return this.snapshot();
    return this.write({draft: this.value.draft, pending: null});
  }
  confirm(schedule) {
    if (!this.value.pending || !matchesInventoryCommand(schedule, this.value.pending.command)) fail('清单保存结果与原请求不一致，已保留待确认请求');
    return this.write({draft: this.value.draft, pending: null});
  }
  discard(initialDraft) {
    if (this.value.pending) fail('待确认请求不能直接清除，请先核对创建结果');
    this.storage.removeItem(this.key);
    if (this.storage.getItem(this.key) !== null) fail('清单草稿未能清除');
    this.value = {draft: validateDraft(initialDraft), pending: null};
    return this.snapshot();
  }
}
