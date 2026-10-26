import {createContext, useContext, useEffect, useLayoutEffect, useRef, useState} from 'react';
// Ephemeral dirty markers only. No document text or private data is persisted here.
const pending = new Map<symbol, symbol | undefined>();
// Host-owned, pure state descriptors. No draft text or imperative confirmation callbacks.
export type UnsavedSessionDescriptor = {token:symbol; scope:symbol; getState:()=>{dirty:boolean;pending:boolean}};
const sessions = new Map<symbol, UnsavedSessionDescriptor>();
function sessionState(descriptor:UnsavedSessionDescriptor) {
 try {const state=descriptor.getState();return {dirty:state.dirty===true,pending:state.pending===true};}
 catch {return {dirty:true,pending:true};} // A failed state reader must not silently discard recovery.
}
function sessionWarn(event:BeforeUnloadEvent) {
 if ([...sessions.values()].some(descriptor=>{const s=sessionState(descriptor);return s.dirty||s.pending;})) {event.preventDefault();event.returnValue='';}
}
export function registerUnsavedSession(descriptor:UnsavedSessionDescriptor):()=>void {
 if(sessions.has(descriptor.token))throw new Error('重复的未保存会话标识');
 sessions.set(descriptor.token,descriptor);
 if(sessions.size===1)window.addEventListener('beforeunload',sessionWarn);
 return ()=>{if(sessions.get(descriptor.token)!==descriptor)return;sessions.delete(descriptor.token);if(sessions.size===0)window.removeEventListener('beforeunload',sessionWarn);};
}
// Optional row ownership lets refreshing lists retain only drafts they would unmount.
const scopeContext = createContext<symbol | undefined>(undefined);
export const UnsavedWorkScope = scopeContext.Provider;
export function hasUnsavedWork(scope: symbol): boolean {
 return [...pending.values()].some(value => value === scope) || [...sessions.values()].some(descriptor=>{if(descriptor.scope!==scope)return false;const s=sessionState(descriptor);return s.dirty||s.pending;});
}
// A router and a mounted editor may both observe the same history event.
const historyDecisions = new WeakMap<Event, boolean>();
export function allowLeavingUnsavedWork(event?: Event): boolean {
 if (restoring) return false;
 if (event && historyDecisions.has(event)) return historyDecisions.get(event)!;
 const retained=[...sessions.values()].some(descriptor=>{const s=sessionState(descriptor);return s.dirty||s.pending;});
 const warning=[pending.size?'有未保存的编辑内容。离开会丢失这些修改。':'',retained?'已纳入恢复的草稿和未确定操作仅保留在当前身份的内存会话中。离开页面不会清除它们；刷新、结束会话或切换身份会丢失恢复信息。离开不会取消已发出的写入。':''].filter(Boolean).join('');
 const allowed = !warning || window.confirm(warning+'是否仍要离开？');
 if (event) historyDecisions.set(event, allowed);
 return allowed;
}
// Compare actual form inputs with this editor instance's initial values, including
// incomplete/invalid text. This baseline stays in memory and is never persisted.
export function useUnsavedDraft(value: unknown) {
 const fingerprint = JSON.stringify(value);
 const initial = useRef(fingerprint);
 useUnsavedWork(fingerprint !== initial.current);
}
// Only our explicit writes create indexed entries. Never patch History globally:
// foreign entries, native fragment navigation and cross-document navigation have
// no reliable traversal delta. A rejected unknown entry retains the mounted UI
// and reports the URL mismatch instead of corrupting the stack to hide it.
const positionKey = '__yanyuOwnedHistory';
const ownedSessions = new Set<string>();
const ownedEntries = new Map<string, Map<number, string>>();
function rememberPosition(position: Position) {
 let entries = ownedEntries.get(position.session);
 if (!entries) ownedEntries.set(position.session, entries = new Map());
 entries.set(position.index, location.href);
}
type Position = {session: string; index: number};
type Accepted = {url: string; position: Position | null};
type Observer = {accept: () => void; status: (message: string | null) => void};
const observers = new Set<Observer>();
let accepted: Accepted | null = null;
let restoring = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let restoreWatchdog: ReturnType<typeof setTimeout> | undefined;
let issue: string | null = null;
let lastObservedUrl = '';
let lastObservedPosition = '';
function positionIdentity() {return JSON.stringify(readPosition());}
const recoveryMessage = '未保存的编辑仍保留在当前页面，但无法确认此历史记录的位置或恢复结果，无法安全恢复地址。地址栏可能与页面不同；请先保存或复制草稿，再使用应用内导航。';
function readPosition(): Position | null {
 const value = history.state?.[positionKey];
 return value && typeof value.session === 'string' && Number.isSafeInteger(value.index) && ownedEntries.get(value.session)?.get(value.index) === location.href ? value : null;
}
function stateWithPosition(position: Position, state: unknown = history.state) {
 // Do not discard callers' object fields. Primitive foreign state is not stamped.
 if (state !== null && state !== undefined) {
  if (typeof state !== 'object' || (Object.getPrototypeOf(state) !== Object.prototype && Object.getPrototypeOf(state) !== null)) return null;
  const existing = (state as Record<string, unknown>)[positionKey] as Position | undefined;
  if (Object.hasOwn(state, positionKey) && (!existing || !ownedSessions.has(existing.session))) return null;
 }
 return {...state as Record<string, unknown> | null, [positionKey]: position};
}
function setIssue(message: string | null) {
 issue = message;
 for (const observer of observers) observer.status(message);
}
function seedCurrent() {
 const position = {session: crypto.randomUUID(), index: 0};
 ownedSessions.add(position.session);
 const state = stateWithPosition(position);
 if (state) {history.replaceState(state, '', location.href); rememberPosition(position);}
 accepted = {url: location.href, position: state ? position : null};
 lastObservedUrl = location.href;
 lastObservedPosition = positionIdentity();
}
function compatible(a: Position | null, b: Position | null) {
 return !!a && !!b && a.session === b.session;
}
function disconnectIfIdle() {
 if (observers.size !== 0 || restoring) return;
 window.removeEventListener('popstate', changedHistory, true);
 window.removeEventListener('hashchange', changedHistory, true);
 clearTimeout(settleTimer); clearTimeout(restoreWatchdog); accepted = null; issue = null;
}
function recoveryFailed() {
 clearTimeout(restoreWatchdog); clearTimeout(settleTimer);
 restoring = false; setIssue(recoveryMessage); disconnectIfIdle();
}
/** A replacement router must not initialize from a transient rejected URL. */
export function unsavedHistoryDisplayUrl(): string {
 return restoring && accepted ? accepted.url : location.href;
}
/** Read-only continuity key for the currently accepted owned entry, never authority.
 * Does not stamp history, seed ownership or adopt a foreign/transient entry. */
export function unsavedHistoryEntryKey(): string | null {
 if(restoring||!accepted||location.href!==accepted.url)return null;
 const current=readPosition();
 if(!compatible(current,accepted.position)||current!.index!==accepted.position!.index)return null;
 return JSON.stringify([current!.session,current!.index,accepted.url]);
}
function settleRestoration() {
 clearTimeout(settleTimer);
 // Coalesce queued user traversals before calculating the next actual delta.
 settleTimer = setTimeout(() => {
  if (!restoring || !accepted) return;
  const current = readPosition();
  if (!compatible(current, accepted.position)) {
   recoveryFailed(); return;
  }
  const delta = accepted.position!.index - current!.index;
  if (delta === 0) {
   restoring = false;
   clearTimeout(restoreWatchdog);
   setIssue(location.href === accepted.url ? null : recoveryMessage);
   disconnectIfIdle();
   return;
  }
  // A browser may ignore a traversal or throw. Never gate app navigation forever.
  clearTimeout(restoreWatchdog);
  restoreWatchdog = setTimeout(recoveryFailed, 1000);
  try {history.go(delta);} catch {recoveryFailed();}
 }, 0);
}
function changedHistory(event: Event) {
 if (!accepted) return;
 if (restoring) {
  event.stopImmediatePropagation(); lastObservedUrl = location.href; lastObservedPosition = positionIdentity();
  settleRestoration(); return;
 }
 // popstate and hashchange can describe the same traversal. Decide only once.
 if (location.href === lastObservedUrl && positionIdentity() === lastObservedPosition) return;
 lastObservedUrl = location.href;
 lastObservedPosition = positionIdentity();
 const current = readPosition();
 if (location.href === accepted.url && compatible(current, accepted.position) && current!.index === accepted.position!.index) {
  event.stopImmediatePropagation(); setIssue(null); return;
 }
 if (!allowLeavingUnsavedWork(event)) {
  event.stopImmediatePropagation();
  if (compatible(current, accepted.position) && current!.index !== accepted.position!.index) {
   restoring = true; settleRestoration();
  } else setIssue(recoveryMessage);
  return;
 }
 accepted = {url: location.href, position: compatible(current, accepted.position) && current!.index !== accepted.position!.index ? current : null};
 setIssue(null);
 for (const observer of [...observers]) observer.accept();
}
export function subscribeUnsavedHistory(accept: () => void, status: Observer['status'] = () => {}) {
 if (observers.size === 0 && !restoring) {
  // Establish a fresh owned segment on mounting, never infer older positions.
  seedCurrent();
  window.addEventListener('popstate', changedHistory, true);
  window.addEventListener('hashchange', changedHistory, true);
 }
 const observer = {accept, status}; observers.add(observer); status(issue);
 return () => {
  observers.delete(observer);
  // A queued native traversal cannot be cancelled on unmount. Keep the shared
  // restoration barrier alive until its event settles, even across remounts.
  disconnectIfIdle();
 };
}
/** Call only after the caller's leave/discard check. False while restoring. */
export function writeUnsavedHistory(url: string | URL, replace = false): boolean {
 if (restoring) return false;
 if (!accepted) seedCurrent();
 const current = readPosition();
 const owned = compatible(current, accepted!.position) && current!.index === accepted!.position!.index && location.href === accepted!.url;
 const position = owned ? {...current!, index: current!.index + (replace ? 0 : 1)} : {session: crypto.randomUUID(), index: 0};
 ownedSessions.add(position.session);
 const state = stateWithPosition(position);
 if (replace) history.replaceState(state ?? history.state, '', url);
 else history.pushState(state ?? history.state, '', url);
 if (state) rememberPosition(position);
 accepted = {url: location.href, position: state ? position : null};
 lastObservedUrl = location.href; setIssue(null);
 lastObservedPosition = positionIdentity();
 return true;
}
export function useUnsavedHistoryDismiss(dismiss: () => void) {
 const [message, setMessage] = useState<string | null>(null);
 const latest = useRef(dismiss); latest.current = dismiss;
 useEffect(() => subscribeUnsavedHistory(() => latest.current(), setMessage), []);
 return message;
}
export function useUnsavedWork(dirty: boolean) {
 const token = useRef(Symbol('editor'));
 const scope = useContext(scopeContext);
 useLayoutEffect(() => {
  if (!dirty) return;
  const key = token.current;
  pending.set(key, scope);
  const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
  window.addEventListener('beforeunload', warn);
  return () => {pending.delete(key); window.removeEventListener('beforeunload', warn);};
 }, [dirty, scope]);
}
