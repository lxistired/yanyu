import { isMeetingReminderLeadSeconds } from '../../shared/organization';
import type { ListOrganizationRecordsRequest, OrganizationRecordPage } from '../../shared/organization';

export const AGENDA_LIMIT = 50;
export const AGENDA_HISTORY_LIMIT = 200;
export type AgendaState = '' | 'scheduled' | 'cancelled' | 'completed';
export type AgendaFilters = { from: string; to: string; state: AgendaState };
/** In-memory view state only; never retain meeting rows or write authority. */
export type AgendaReturnContext = { filters:AgendaFilters; offsets:number[]; date:string; period:AgendaPeriod };
export function agendaReturnContext(value:AgendaReturnContext|undefined):AgendaReturnContext|undefined {
  if(!value)return undefined;
  try {
    agendaRequest(value.filters);
    if(!Array.isArray(value.offsets)||!value.offsets.length||value.offsets.length>AGENDA_HISTORY_LIMIT||value.offsets[0]!==0||value.offsets.some((n,i)=>!Number.isSafeInteger(n)||n<0||n>10000||(i>0&&n<=value.offsets[i-1])))return undefined;
    if(typeof value.date!=='string'||!['day','week'].includes(value.period))return undefined;
    return {filters:{...value.filters},offsets:[...value.offsets],date:value.date,period:value.period};
  } catch {return undefined;}
}
/** Only the exact source history entry can consume the single return ticket. */
export function agendaHistoryReturn(ticket:{key:string;context:AgendaReturnContext}|null,page:string,unknown:string|undefined,key:string|null):AgendaReturnContext|undefined {
  return ticket&&page==='calendar'&&!unknown&&ticket.key===key?agendaReturnContext(ticket.context):undefined;
}
const invalid = (): never => { throw new Error('INVALID_LOCAL_MEETING_PAGE'); };
const encoder = new TextEncoder();
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const names = Reflect.ownKeys(value);
  if (keys.some(key => !Object.hasOwn(value, key)) || names.length < keys.length || names.length > keys.length + optional.length) return invalid();
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || (!keys.includes(key) && !optional.includes(key)) || !d.enumerable || !('value' in d)) return invalid();
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false, multiline = false): string {
  if (typeof value !== 'string' || value.length > max || encoder.encode(value).length > max || (!empty && !value.trim()) || (multiline ? /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/ : /[\x00-\x1F\x7F]/).test(value)) return invalid();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) return invalid();
  return value;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return invalid();
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !('value' in d)) return invalid();
  }
  return value;
}
/** Explicit offsets are instants, never browser-local wall times. */
export function agendaInstant(value: unknown): string {
  const raw = text(value, 40);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!m) return invalid();
  const [,y,mo,d,h,mi,s,,zone] = m;
  if (+y < 1970 || +y > 2100 || +mo < 1 || +mo > 12 || +d < 1 || +d > new Date(Date.UTC(+y,+mo,0)).getUTCDate() || +h > 23 || +mi > 59 || +s > 59 || (zone !== 'Z' && (+zone.slice(1,3) > 14 || +zone.slice(4) > 59 || (+zone.slice(1,3) === 14 && +zone.slice(4) !== 0)))) return invalid();
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 2100) return invalid();
  return date.toISOString();
}
function namedZone(value: unknown): string {
  const zone = text(value,100);
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone)) return invalid();
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { return invalid(); }
  return zone;
}
export function agendaRequest(filters: AgendaFilters, offset = 0): ListOrganizationRecordsRequest<'meeting'> {
  if (integer(offset) > 10000 || !['','scheduled','cancelled','completed'].includes(filters.state)) return invalid();
  const result: ListOrganizationRecordsRequest<'meeting'> = { kind:'meeting', includeDeleted:false, sortBy:'date', direction:'asc', limit:AGENDA_LIMIT, offset };
  for (const key of ['from','to'] as const) if (filters[key]) {
    if (!filters[key].endsWith('Z')) return invalid();
    result[key] = agendaInstant(filters[key]);
  }
  if (result.from && result.to && result.from >= result.to) return invalid();
  if (filters.state) result.state = filters.state;
  return result;
}
/** Validate the actual DomainRecord envelope, not a convenient invented projection. */
export function validateAgendaPage(value: unknown, request: ListOrganizationRecordsRequest<'meeting'>): OrganizationRecordPage<'meeting'> {
  const page = object(value, ['items','total','offset','nextOffset']);
  const total = integer(page.total), offset = integer(page.offset);
  if (offset !== request.offset || offset > 10000) return invalid();
  const items = array(page.items, AGENDA_LIMIT);
  if (items.length > Math.max(0,total-offset) || (!items.length && offset < total)) return invalid();
  const next = offset + items.length;
  if (page.nextOffset !== (next < total ? next : null)) return invalid();
  const seen = new Set<string>();
  let previous: { start: string; id: string } | undefined;
  for (const item of items) {
    const record = object(item,['id','kind','revision','createdAt','updatedAt','deletedAt','data']);
    const recordId = id(record.id);
    if (record.kind !== 'meeting' || record.deletedAt !== null || seen.has(recordId)) return invalid();
    seen.add(recordId); integer(record.revision,1);
    agendaInstant(record.createdAt); agendaInstant(record.updatedAt);
    const data = object(record.data,['title','organizationId','series','category','startsAt','endsAt','timezone','location','description','attendeeIds','state','providerAvailability'],['reminderLeadSeconds']);
    if (Object.hasOwn(data, 'reminderLeadSeconds') && data.reminderLeadSeconds !== null && !isMeetingReminderLeadSeconds(data.reminderLeadSeconds)) return invalid();
    text(data.title,720); text(data.series,720,true); text(data.location,720,true); text(data.description,16000,true,true);
    if (data.organizationId !== null) id(data.organizationId);
    if (!['roadshow','strategy','research','forum','other'].includes(data.category as string) || !['scheduled','cancelled','completed'].includes(data.state as string) || data.providerAvailability !== 'unconfigured') return invalid();
    const attendees = array(data.attendeeIds,200).map(id);
    if (new Set(attendees).size !== attendees.length) return invalid();
    const start = agendaInstant(data.startsAt), end = agendaInstant(data.endsAt);
    if (end <= start || Date.parse(end)-Date.parse(start) > 31*86400000) return invalid();
    namedZone(data.timezone);
    if ((request.from && start < request.from) || (request.to && start >= request.to) || (request.state && data.state !== request.state)) return invalid();
    if (previous && (start < previous.start || (start === previous.start && recordId.localeCompare(previous.id) <= 0))) return invalid();
    previous = {start,id:recordId};
  }
  return value as OrganizationRecordPage<'meeting'>;
}
export function formatAgendaInstant(instant: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone:namedZone(timezone), year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset' }).format(new Date(agendaInstant(instant)));
  } catch { return '时间无法显示'; }
}

/** Date navigation is explicitly UTC, not the browser's local date or meeting display zone. */
export type AgendaPeriod = 'day' | 'week';
export function agendaDateRange(date: string, period: AgendaPeriod): Pick<AgendaFilters, 'from' | 'to'> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['day','week'].includes(period)) return invalid();
  const start = new Date(agendaInstant(date + 'T00:00:00Z'));
  if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + (period === 'week' ? 7 : 1));
  return { from: agendaInstant(start.toISOString()), to: agendaInstant(end.toISOString()) };
}
export function shiftAgendaDate(date: string, period: AgendaPeriod, direction: -1 | 1): string {
  const start = new Date(agendaDateRange(date,period).from);
  start.setUTCDate(start.getUTCDate() + direction * (period === 'week' ? 7 : 1));
  const result = start.toISOString().slice(0,10);
  agendaDateRange(result,period);
  return result;
}
