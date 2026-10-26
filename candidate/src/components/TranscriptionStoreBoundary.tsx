import {createContext, useContext, useState, useSyncExternalStore, type ReactNode} from 'react';
import {readStoreLink, TranscriptionStoreSession, StoreContinuityError} from './transcription-store-session';
const StoreContext = createContext<TranscriptionStoreSession | null>(null);
export function useTranscriptionStore() {
  const session = useContext(StoreContext);
  if (!session) throw new Error('Transcription actions require an explicit store boundary');
  useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  return session;
}
export function TranscriptionStoreBoundary({children}: {children: ReactNode}) {
  const [entry] = useState(() => {try {return {session: new TranscriptionStoreSession(readStoreLink(new URL(location.href))), invalid: false};} catch {return {session: null, invalid: true};}});
  const [ready, setReady] = useState(!!entry.session?.scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (entry.invalid || !entry.session) return <p role="alert">来源链接无效或含有重复参数。请使用有效链接，或重新进入转写资料库并明确选择来源。</p>;
  const session = entry.session;
  if (!ready) return <section aria-label="选择转写来源"><h2>选择转写来源</h2><p>此入口没有可核验的转写来源。选择当前服务只表示查看当前来源，不能证明旧链接、搜索结果或历史记录来自这里。</p><button disabled={busy || session.blocked} onClick={async () => {if(busy || session.blocked)return;setBusy(true);try {await session.discover();setReady(true);} catch(e) {setError(e instanceof Error ? e.message : '无法核验来源');} finally {setBusy(false);}}}>明确选择当前转写来源</button>{error && <p role="alert">{error}</p>}</section>;
  return <StoreContext.Provider value={session}><StoreNotice/>{children}</StoreContext.Provider>;
}
function StoreNotice() {
  const session = useTranscriptionStore();
  return session.blocked ? <p role="alert">{new StoreContinuityError().message} 本页不会自动切换来源；重新进入前请先处理未保存内容。</p> : <p role="status">当前转写来源已固定：{session.scope}（逻辑资料库标识，不是来源真实性证明）</p>;
}
