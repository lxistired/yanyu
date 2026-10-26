import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  FeedbackCapabilities,
  FeedbackCategory,
  FeedbackPage,
  FeedbackRecord,
} from '../../shared/feedback';
import {
  feedbackApi,
  FeedbackOwnerError,
  requireFeedbackCapabilities,
  requireFeedbackPage,
  requireFeedbackRecord,
  requireFeedbackSettlement,
  validFeedbackScope,
  validFeedbackText,
  type FeedbackClient,
} from '../adapters/feedback';
import {
  assertFeedbackIntentPresent,
  clearSettledFeedbackIntent,
  feedbackSettlementRequest,
  FeedbackJournalError,
  prepareFeedbackIntent,
  readFeedbackIntent,
  settleFeedbackIntent,
  type FeedbackIntent,
  type FeedbackJournalEntry,
} from '../adapters/feedback-journal';
import { ApiError } from '../adapters/api';
import './feedback-workspace.css';

const statusText: Record<FeedbackRecord['delivery']['state'], string> = {
  'local-recorded': '已保存到当前工作区',
  'external-unknown': '外部结果未知',
  'external-submitted': '已提交至配置接口',
  'external-accepted': '外部接口已确认受理',
  'external-delivered': '外部接口已确认送达',
  'external-failed': '外部提交已确认失败',
};
const statusDetail: Record<FeedbackRecord['delivery']['state'], string> = {
  'local-recorded': '仅保存在当前工作区，未发送给外部支持方。',
  'external-unknown': '无法确认外部处理结果。核对状态不会重新发送反馈。',
  'external-submitted': '接口已确认提交；尚未确认受理或送达。',
  'external-accepted': '配置接口已报告受理；尚未确认送达或人工处理。',
  'external-delivered': '配置接口已明确报告送达；这不代表人工阅读或答复。',
  'external-failed': '配置接口已报告失败。此页面不会自动重发。',
};
const categoryText = (value: FeedbackCategory) => (value === 'problem' ? '问题' : '建议');
const message = (error: unknown) => (error instanceof Error ? error.message : '反馈服务暂不可用');
const characters = (text: string) => Array.from(text).length;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function newKey(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('当前浏览器无法生成安全命令标识，未发送');
  return globalThis.crypto.randomUUID();
}
export interface FeedbackWorkspaceProps {
  available: boolean;
  /** Parent-verified App display.identityScope, never a user-selected owner. */
  expectedOwnerScope: string | null;
  /** Change on every authentication/session replacement, including same-owner re-entry. */
  lifecycleKey: string;
  onClose?: () => void;
  client?: FeedbackClient;
}
/** Opening this leaf performs protected reads only. It does not save or send anything. */
export function FeedbackWorkspace(props: FeedbackWorkspaceProps) {
  if (!props.available || !validFeedbackScope(props.expectedOwnerScope))
    return (
      <section className="feedback-workspace" aria-label="帮助与反馈">
        <h2>帮助与反馈</h2>
        <p role="status">反馈存储或当前身份尚未就绪。使用说明仍可阅读。</p>
        {props.onClose && (
          <button type="button" onClick={props.onClose}>
            关闭反馈
          </button>
        )}
      </section>
    );
  return (
    <FeedbackSession
      key={`${props.lifecycleKey}:${props.expectedOwnerScope}`}
      {...props}
      expectedOwnerScope={props.expectedOwnerScope}
    />
  );
}
/** Controlled entry seam: host owns visibility, navigation, and authentication lifecycle. */
export function FeedbackEntry(props: FeedbackWorkspaceProps & { open: boolean; onOpen: () => void }) {
  return (
    <div className="feedback-entry">
      <button type="button" onClick={props.onOpen} aria-expanded={props.open}>
        我的反馈
      </button>
      {props.open && <FeedbackWorkspace {...props} />}
    </div>
  );
}
function FeedbackSession({
  expectedOwnerScope: scope,
  onClose,
  client = feedbackApi,
}: FeedbackWorkspaceProps & { expectedOwnerScope: string }) {
  const id = useId();
  const [capabilities, setCapabilities] = useState<FeedbackCapabilities | null>(null);
  const [page, setPage] = useState<FeedbackPage | null>(null);
  const [detail, setDetail] = useState<FeedbackRecord | null>(null);
  const [category, setCategory] = useState<FeedbackCategory>('problem');
  const [draft, setDraft] = useState('');
  const [localReview, setLocalReview] = useState<{ category: FeedbackCategory; text: string } | null>(null);
  const [externalReview, setExternalReview] = useState<FeedbackRecord | null>(null);
  const [pending, setPending] = useState<FeedbackJournalEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const life = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const invalidated = useRef(false);
  const readSequence = useRef(0);
  const storage = () => window.sessionStorage;
  const current = (controller: AbortController) =>
    life.current === controller && !controller.signal.aborted && !invalidated.current;
  function revoke() {
    invalidated.current = true;
    life.current?.abort();
    setCapabilities(null);
    setPage(null);
    setDetail(null);
    setPending(null);
    setDraft('');
    setLocalReview(null);
    setExternalReview(null);
    setNotice('');
    setStorageError('');
    setBusy(false);
    setError('当前反馈身份或权限已变化，已隐藏全部反馈内容。请返回并重新打开。');
  }
  function failed(cause: unknown, controller: AbortController) {
    if (!current(controller)) return;
    if (
      cause instanceof FeedbackOwnerError ||
      (cause instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(cause.detail.code))
    )
      revoke();
    else if (cause instanceof FeedbackJournalError) setStorageError(message(cause));
    else setError(message(cause));
  }
  async function list(controller: AbortController, cursor: string | null) {
    const sequence = ++readSequence.current;
    const result = await client.list(
      { expectedScopeKey: scope, cursor, limit: capabilities?.limits.pageSize ?? 20 },
      controller.signal,
    );
    if (!current(controller)) return;
    const verified = requireFeedbackPage(result, scope);
    if (sequence === readSequence.current) setPage(verified);
  }
  // Fence the old lifetime at commit, before replacement layout effects can resolve old work.
  // Reads stay in the passive effect below; layout only creates/invalidates the local token.
  useLayoutEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    invalidated.current = false;
    return () => {
      controller.abort();
      if (life.current === controller) life.current = null;
    };
  }, [scope, client, refresh]);
  useEffect(() => {
    const controller = life.current;
    if (!controller) return;
    locked.current = false;
    setCapabilities(null);
    setPage(null);
    setDetail(null);
    setPending(null);
    setDraft('');
    setLocalReview(null);
    setExternalReview(null);
    setError('');
    setNotice('');
    setStorageError('');
    setBusy(false);
    setCursorStack([null]);
    void (async () => {
      const value = await client.read(controller.signal);
      if (!current(controller)) return;
      const verified = requireFeedbackCapabilities(value, scope);
      setCapabilities(verified);
      // Never access a browser namespace until the server and surrounding App agree on the owner.
      try {
        setPending(readFeedbackIntent(storage(), scope));
      } catch (cause) {
        setStorageError(message(cause));
      }
      const sequence = ++readSequence.current;
      const result = await client.list(
        { expectedScopeKey: scope, cursor: null, limit: verified.limits.pageSize },
        controller.signal,
      );
      if (current(controller)) {
        const verifiedPage = requireFeedbackPage(result, scope);
        if (sequence === readSequence.current) setPage(verifiedPage);
      }
    })().catch((cause: unknown) => failed(cause, controller));
    return () => controller.abort();
    // The keyed parent remounts for scope/lifecycle replacements; client replacement also fences work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, client, refresh]);
  async function action(work: (controller: AbortController) => Promise<void>) {
    const controller = life.current;
    if (!controller || !current(controller) || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work(controller);
    } catch (cause) {
      failed(cause, controller);
    } finally {
      if (current(controller)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function checkedRecord(value: unknown): FeedbackRecord {
    return requireFeedbackRecord(value, scope);
  }
  async function dispatch(entry: FeedbackJournalEntry, controller: AbortController) {
    assertFeedbackIntentPresent(storage(), entry);
    const intent = entry.intent;
    const result =
      intent.action === 'create'
        ? await client.create(intent.request, controller.signal)
        : intent.action === 'submit'
          ? await client.submit(intent.request, controller.signal)
          : await client.reconcile(intent.request, controller.signal);
    if (!current(controller)) return;
    const record = checkedRecord(result);
    if (
      intent.action === 'create'
        ? record.category !== intent.request.category || record.text !== intent.request.text
        : record.id !== intent.request.id ||
          record.category !== intent.review.category ||
          record.text !== intent.review.text ||
          record.revision < intent.request.expectedRevision ||
          (intent.action === 'submit' &&
            record.delivery.destination?.key !== intent.request.expectedDestinationKey)
    )
      throw new Error('反馈结果与原命令不符；原命令已保留');
    assertFeedbackIntentPresent(storage(), entry);
    setDetail(record);
    setExternalReview(null);
    if (record.delivery.state === 'external-unknown' && intent.action !== 'create') {
      setNotice('外部结果仍未知，原命令已保留。请明确核对原命令，不要重复提交。');
    } else {
      settleFeedbackIntent(storage(), entry, record);
      setPending(null);
      setLocalReview(null);
      setDraft('');
      setNotice(
        intent.action === 'create'
          ? `已保存到当前工作区，参考编号 ${record.reference}`
          : statusText[record.delivery.state],
      );
    }
    setCursorStack([null]);
    await list(controller, null);
  }
  async function prepare(intent: FeedbackIntent, controller: AbortController) {
    const entry = prepareFeedbackIntent(storage(), scope, intent);
    setPending(entry);
    // Full exact command is durably journaled and read back before the first transport attempt.
    await dispatch(entry, controller);
  }
  function settleOriginal(entry: FeedbackJournalEntry) {
    void action(async (controller) => {
      assertFeedbackIntentPresent(storage(), entry);
      const request = feedbackSettlementRequest(entry);
      const value = await client.settleCommand(request, controller.signal);
      if (!current(controller)) return;
      const result = requireFeedbackSettlement(value, request);
      clearSettledFeedbackIntent(storage(), entry, result);
      setPending(null);
      setLocalReview(null);
      setExternalReview(null);
      setDraft(
        result.resolution === 'closed' && entry.intent.action === 'create' ? entry.intent.request.text : '',
      );
      if (entry.intent.action === 'create') setCategory(entry.intent.request.category);
      setDetail(result.record);
      setNotice(
        result.resolution === 'closed'
          ? '原命令已取消并关闭，未执行的命令不会稍后补发。'
          : '已核实原命令的已记录结果；没有重新发送反馈。',
      );
      setCursorStack([null]);
      await list(controller, null);
    });
  }
  function save() {
    if (!localReview || pending || storageError) return;
    const review = localReview;
    void action((controller) =>
      prepare(
        {
          action: 'create',
          request: {
            expectedScopeKey: scope,
            category: review.category,
            text: review.text,
            reviewedDestination: 'local-workspace',
            idempotencyKey: newKey(),
          },
        },
        controller,
      ),
    );
  }
  function submit() {
    if (!externalReview || !capabilities?.external || pending || storageError) return;
    const record = externalReview,
      destination = capabilities.external;
    void action((controller) =>
      prepare(
        {
          action: 'submit',
          request: {
            expectedScopeKey: scope,
            id: record.id,
            expectedRevision: record.revision,
            expectedDestinationKey: destination.key,
            idempotencyKey: newKey(),
          },
          review: { category: record.category, text: record.text, destination },
        },
        controller,
      ),
    );
  }
  function reconcile(record: FeedbackRecord) {
    if (pending || storageError) return;
    void action((controller) =>
      prepare(
        {
          action: 'reconcile',
          request: {
            expectedScopeKey: scope,
            id: record.id,
            expectedRevision: record.revision,
            idempotencyKey: newKey(),
          },
          review: { category: record.category, text: record.text, destination: record.delivery.destination },
        },
        controller,
      ),
    );
  }
  function openRecord(recordId: string) {
    void action(async (controller) => {
      const record = await client.detail({ expectedScopeKey: scope, id: recordId }, controller.signal);
      if (!current(controller)) return;
      const verified = checkedRecord(record);
      if (verified.id !== recordId) throw new Error('反馈详情与请求编号不符');
      setDetail(verified);
      setExternalReview(null);
    });
  }
  function pageTo(stack: (string | null)[]) {
    void action(async (controller) => {
      await list(controller, stack[stack.length - 1]);
      if (current(controller)) setCursorStack(stack);
    });
  }
  const validDraft =
    !!capabilities &&
    validFeedbackText(draft, capabilities.limits.textCharacters, capabilities.limits.textBytes);
  return (
    <section className="feedback-workspace" aria-labelledby={`${id}-title`} aria-busy={busy}>
      <header className="feedback-workspace__header">
        <div>
          <h2 id={`${id}-title`}>帮助与反馈</h2>
          <p>填写问题或建议，保存后可在“我的反馈”查看。</p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose}>
            关闭反馈
          </button>
        )}
      </header>
      <p className="feedback-workspace__privacy">
        仅收集你明确填写的类别和文字。不会自动附加资料、录音、日志、凭证或联系方式。确认命令会临时保存在当前标签页，以便刷新后核对；不要填写密码或敏感资料。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {storageError && (
        <p role="alert">{storageError}。历史仍可查看；新命令已停用。请关闭并重新打开反馈以重新核验。</p>
      )}
      {!capabilities ? (
        <>
          {!error && <p role="status">正在核验身份并读取反馈</p>}
          {!invalidated.current && error && (
            <button type="button" onClick={() => setRefresh((n) => n + 1)}>
              重新读取反馈
            </button>
          )}
        </>
      ) : (
        <>
          {pending && (
            <section className="feedback-workspace__pending" aria-label="待确认的原命令">
              <h3>原命令结果待确认</h3>
              <p>刷新、关闭或返回不会重发，也不会清除原命令。请先核对，再填写新反馈。</p>
              <p>
                操作：
                {pending.intent.action === 'create'
                  ? '保存到当前工作区'
                  : pending.intent.action === 'submit'
                    ? '外部提交'
                    : '核对外部状态'}
              </p>
              {pending.intent.action !== 'create' && (
                <p>原目标：{pending.intent.review.destination?.label ?? '当前工作区'}</p>
              )}
              <p>
                命令标识：
                <span className="feedback-workspace__identifier">
                  {pending.intent.request.idempotencyKey}
                </span>
              </p>
              <pre className="feedback-workspace__text">
                {pending.intent.action === 'create'
                  ? pending.intent.request.text
                  : pending.intent.review.text}
              </pre>
              {pending.intent.action === 'create' && (
                <button
                  type="button"
                  disabled={busy || !!storageError}
                  onClick={() => void action((controller) => dispatch(pending, controller))}
                >
                  用原命令确认本地保存
                </button>
              )}
              <p>下面的核实操作会取消尚未执行的原命令；已记录的结果会保留，不会重新发送反馈。</p>
              <button type="button" disabled={busy || !!storageError} onClick={() => settleOriginal(pending)}>
                取消未完成命令并核实结果
              </button>
            </section>
          )}
          {!pending && (
            <section aria-label="填写反馈">
              <h3>新的反馈</h3>
              {localReview ? (
                <section aria-label="核对本地保存">
                  <p>类别：{categoryText(localReview.category)}</p>
                  <p>保存位置：当前工作区（仅当前身份可见）</p>
                  <pre className="feedback-workspace__text">{localReview.text}</pre>
                  <div className="feedback-workspace__actions">
                    <button type="button" disabled={busy || !!storageError} onClick={save}>
                      确认保存到当前工作区
                    </button>
                    <button type="button" disabled={busy} onClick={() => setLocalReview(null)}>
                      返回修改
                    </button>
                  </div>
                </section>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (validDraft && !busy) setLocalReview({ category, text: draft });
                  }}
                >
                  <label htmlFor={`${id}-category`}>反馈类别</label>
                  <select
                    id={`${id}-category`}
                    value={category}
                    disabled={busy}
                    onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
                  >
                    <option value="problem">问题</option>
                    <option value="suggestion">建议</option>
                  </select>
                  <label htmlFor={`${id}-text`}>反馈内容</label>
                  <textarea
                    id={`${id}-text`}
                    value={draft}
                    disabled={busy}
                    rows={6}
                    maxLength={capabilities.limits.textCharacters * 2}
                    aria-describedby={`${id}-count`}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <p id={`${id}-count`}>
                    {characters(draft)} / {capabilities.limits.textCharacters} 字符，{bytes(draft)} /{' '}
                    {capabilities.limits.textBytes} 字节
                  </p>
                  <button type="submit" disabled={busy || !validDraft || !!storageError}>
                    核对保存内容
                  </button>
                </form>
              )}
            </section>
          )}
          <section aria-label="我的反馈">
            <div className="feedback-workspace__header">
              <h3>我的反馈</h3>
              <button type="button" disabled={busy} onClick={() => pageTo([null])}>
                刷新历史
              </button>
            </div>
            {!page ? (
              <p role="status">正在读取历史</p>
            ) : page.records.length === 0 ? (
              <p>当前还没有反馈记录</p>
            ) : (
              <ul className="feedback-workspace__history">
                {page.records.map((record) => (
                  <li key={record.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => openRecord(record.id)}
                      aria-label={`查看反馈 ${record.reference}`}
                    >
                      <span className="feedback-workspace__identifier">{record.reference}</span>
                      <span>
                        {categoryText(record.category)} · {statusText[record.delivery.state]}
                      </span>
                    </button>
                    <time dateTime={record.createdAt}>{record.createdAt}</time>
                  </li>
                ))}
              </ul>
            )}
            <div className="feedback-workspace__pagination" role="group" aria-label="反馈历史分页">
              <button
                type="button"
                disabled={busy || cursorStack.length < 2}
                onClick={() => pageTo(cursorStack.slice(0, -1))}
              >
                上一页
              </button>
              <span>第 {cursorStack.length} 页</span>
              <button
                type="button"
                disabled={busy || !page?.nextCursor}
                onClick={() => page?.nextCursor && pageTo([...cursorStack, page.nextCursor])}
              >
                下一页
              </button>
            </div>
          </section>
          {detail && (
            <section aria-label="反馈详情" className="feedback-workspace__detail">
              <h3>反馈详情</h3>
              <p>
                参考编号：<span className="feedback-workspace__identifier">{detail.reference}</span>
              </p>
              <p>类别：{categoryText(detail.category)}</p>
              <p>
                创建时间：<time dateTime={detail.createdAt}>{detail.createdAt}</time>
              </p>
              <pre className="feedback-workspace__text">{detail.text}</pre>
              <p>{statusText[detail.delivery.state]}</p>
              <p>{statusDetail[detail.delivery.state]}</p>
              {detail.delivery.destination && <p>已记录的外部目标：{detail.delivery.destination.label}</p>}
              {detail.delivery.receipt && (
                <p>
                  接口回执：<span className="feedback-workspace__identifier">{detail.delivery.receipt}</span>
                </p>
              )}
              <div className="feedback-workspace__actions">
                <button type="button" disabled={busy} onClick={() => openRecord(detail.id)}>
                  刷新详情
                </button>
                {!pending && detail.delivery.state === 'local-recorded' && capabilities.external && (
                  <button
                    type="button"
                    disabled={busy || !!storageError}
                    onClick={() => {
                      setLocalReview(null);
                      setExternalReview(detail);
                    }}
                  >
                    核对外部提交
                  </button>
                )}
                {!pending &&
                  detail.delivery.destination?.canReconcile &&
                  ['external-unknown', 'external-submitted', 'external-accepted'].includes(
                    detail.delivery.state,
                  ) && (
                    <button type="button" disabled={busy || !!storageError} onClick={() => reconcile(detail)}>
                      仅核对外部状态（不重发）
                    </button>
                  )}
              </div>
              {externalReview && capabilities.external && (
                <section aria-label="确认外部提交" className="feedback-workspace__external">
                  <h4>确认向外部支持方提交</h4>
                  <p>目标：{capabilities.external.label}</p>
                  <p>将发送此已保存记录的类别和以下完整文字。文字不可在提交时修改。</p>
                  <p>类别：{categoryText(externalReview.category)}</p>
                  <pre className="feedback-workspace__text">{externalReview.text}</pre>
                  <div className="feedback-workspace__actions">
                    <button type="button" disabled={busy || !!pending || !!storageError} onClick={submit}>
                      确认向此目标提交以上文字
                    </button>
                    <button type="button" disabled={busy} onClick={() => setExternalReview(null)}>
                      取消外部提交
                    </button>
                  </div>
                </section>
              )}
              {!capabilities.external && detail.delivery.state === 'local-recorded' && (
                <p>未配置外部支持目标；本地保存已可用。</p>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
