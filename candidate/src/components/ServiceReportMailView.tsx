import type {
  ServiceMailProvider,
  ServiceMailRequest,
  ServiceMailState,
} from '../../shared/service-report-mail';
import type { ServiceReportMailViewProps } from './service-report-mail-view-types';
import './service-report-mail.css';

const stateLabels: Record<ServiceMailState, string> = {
  queued: '请求已入队',
  blocked: '发送已阻止',
  dispatching: '正在交付服务商',
  'provider-accepted': '服务商已接受',
  'known-rejected': '已明确拒绝',
  'outcome-unknown': '发送结果未知',
  'cancelled-before-dispatch': '已在发送前取消',
};
const reasonLabels: Record<string, string> = {
  unconfigured: '邮件服务尚未配置',
  'authority-unavailable': '当前授权不可用',
  'consent-changed': '订阅授权已改变',
  'recipient-changed': '收件地址版本已改变',
  'report-changed': '月报版本已改变',
  'source-unavailable': '月报来源不可用',
  'missed-occurrence': '已错过发送窗口，订阅已暂停',
  'provider-changed': '邮件服务配置已改变',
};
function ProviderBadge({ provider }: { provider: ServiceMailProvider | null }) {
  return (
    <span
      className={`service-mail__badge service-mail__badge--${provider?.mode === 'synthetic' ? 'synthetic' : provider?.mode === 'configured' ? 'configured' : 'warning'}`}
    >
      {provider?.mode === 'synthetic'
        ? '本地模拟通道'
        : provider?.mode === 'configured'
          ? '已配置邮件通道'
          : '邮件通道未就绪'}
    </span>
  );
}
function requestLabel(request: ServiceMailRequest): string {
  if (request.state === 'provider-accepted' && request.simulated)
    return '模拟接受 · 未发送真实邮件';
  return stateLabels[request.state];
}
/** Controlled view: all mutation, confirmation invalidation, and recovery belong to the workspace. */
export function ServiceReportMailView(props: ServiceReportMailViewProps) {
  const ready = props.overview.state === 'ready';
  const overview =
    props.overview.state === 'ready' ? props.overview.value : null;
  const locked =
    props.busy || props.pending !== null || props.journalBlocked || !ready;
  const customer =
    props.customer.state === 'ready' ? props.customer.value : null;
  const recipients = overview?.recipients ?? [];
  const activeRecipients = recipients.filter((item) => !item.disabled);
  const currentRecipient = activeRecipients.find(
    (item) => item.id === props.selectedRecipientId,
  );
  const providerReady =
    overview !== null && overview.provider.mode !== 'unavailable';
  const preview = props.preview.state === 'ready' ? props.preview.value : null;
  return (
    <section
      className="service-mail"
      aria-label="月报邮件工作台"
      aria-busy={props.busy}
    >
      <header className="service-mail__hero">
        <div>
          <div className="service-mail__eyebrow">
            SERVICE LETTER / 月度服务通信
          </div>
          <h2>把每月的服务，认真送达</h2>
          <p>
            维护收件邮箱、设置月度订阅，或为选中的月报发起一次发送。每次请求都保留可核对的记录。
          </p>
        </div>
        <div className="service-mail__hero-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none">
            <rect
              x="3"
              y="7"
              width="26"
              height="19"
              rx="3"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path d="m4 9 12 9L28 9" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M20 4h7M24 1v6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </header>
      <div className="service-mail__context">
        <div>
          当前客户
          <strong>
            {customer
              ? `${customer.organizationName}${customer.contactName ? ` · ${customer.contactName}` : ''}`
              : '尚未选择可访问客户'}
          </strong>
        </div>
        <div>
          当前月报
          <strong>
            {props.report.state === 'ready'
              ? `${props.report.value.month} · 修订 ${props.report.value.reportRevision}`
              : '请选择精确月报版本'}
          </strong>
        </div>
        <div>
          <ProviderBadge provider={overview?.provider ?? null} />
        </div>
      </div>
      <div className="service-mail__body">
        {props.error && (
          <div
            role="alert"
            className="service-mail__notice service-mail__notice--error"
          >
            {props.error}
          </div>
        )}
        {props.notice && (
          <div role="status" className="service-mail__notice">
            {props.notice}
          </div>
        )}
        {props.pending && (
          <aside className="service-mail__pending" aria-label="未确认的原操作">
            <h3>{props.pending.label}</h3>
            <p>{props.pending.message}</p>
            <p className="service-mail__digest">
              原操作标识：{props.pending.token}
            </p>
            <div className="service-mail__actions">
              <button
                className="service-mail__button"
                disabled={props.pending.sending || props.busy}
                onClick={props.onCheckPending}
              >
                检查原操作结果
              </button>
              <button
                className="service-mail__button service-mail__button--warning"
                disabled={props.pending.sending || props.busy}
                onClick={props.onCancelPending}
              >
                取消尚未提交的原操作
              </button>
            </div>
            <p>
              页面关闭或网络中断不会清除这条恢复记录。结果未知时不会创建另一条发送请求。
            </p>
          </aside>
        )}
        {!ready && (
          <div
            role="status"
            className="service-mail__notice service-mail__notice--warning"
          >
            {props.overview.state !== 'ready' && props.overview.message}
            <div className="service-mail__actions">
              <button
                className="service-mail__button"
                onClick={props.onRefresh}
                disabled={props.busy || props.customer.state !== 'ready'}
              >
                重新读取邮件设置
              </button>
            </div>
          </div>
        )}
        {overview?.provider.mode === 'unavailable' && (
          <div className="service-mail__notice service-mail__notice--warning">
            邮件服务未配置。可以保存地址；发送预览与开启订阅需要管理员配置可用通道。保存邮箱不会触发验证邮件或自动订阅。
          </div>
        )}
        {overview?.provider.mode === 'synthetic' && (
          <div className="service-mail__notice service-mail__notice--warning">
            当前为本地合成测试：通道接受只代表模拟结果，不会向真实邮箱投递，也不是送达证明。
          </div>
        )}
        <div className="service-mail__columns">
          <div className="service-mail__stack">
            <section
              className="service-mail__panel"
              aria-labelledby="service-mail-recipients-title"
            >
              <div className="service-mail__panel-head">
                <div>
                  <h3 id="service-mail-recipients-title">
                    <span className="service-mail__step">01</span>收件邮箱
                  </h3>
                  <p>地址绑定当前客户，版本变更后重新确认</p>
                </div>
                <button
                  className="service-mail__button"
                  disabled={locked || props.recipientDraft !== null}
                  onClick={props.onAddRecipient}
                >
                  添加邮箱
                </button>
              </div>
              {recipients.length === 0 ? (
                <div className="service-mail__empty">
                  还没有收件地址
                  <br />
                  添加邮箱后，再单独授权订阅或发送
                </div>
              ) : (
                <ul className="service-mail__recipients">
                  {recipients.map((recipient) => (
                    <li className="service-mail__recipient" key={recipient.id}>
                      <div className="service-mail__recipient-top">
                        <div>
                          <div className="service-mail__address">
                            {recipient.address}
                          </div>
                          <div className="service-mail__recipient-meta">
                            地址修订 {recipient.revision} · 未验证邮箱归属
                          </div>
                        </div>
                        <span className="service-mail__badge">
                          {recipient.disabled ? '已停用' : '可选择'}
                        </span>
                      </div>
                      <div className="service-mail__actions">
                        <button
                          className="service-mail__button service-mail__button--quiet"
                          disabled={locked}
                          onClick={() => props.onEditRecipient(recipient)}
                        >
                          编辑 {recipient.address}
                        </button>
                        {!recipient.disabled && (
                          <button
                            className="service-mail__button service-mail__button--quiet"
                            disabled={locked}
                            onClick={() => props.onDisableRecipient(recipient)}
                          >
                            停用 {recipient.address}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {props.recipientDraft && (
                <form
                  className="service-mail__form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    props.onSaveRecipient();
                  }}
                >
                  <label className="service-mail__field">
                    {props.recipientDraft.id ? '编辑邮箱地址' : '新邮箱地址'}
                    <input
                      type="email"
                      autoComplete="off"
                      maxLength={254}
                      required
                      value={props.recipientDraft.address}
                      disabled={locked}
                      onChange={(event) =>
                        props.onRecipientDraftChange({
                          ...props.recipientDraft!,
                          address: event.target.value,
                        })
                      }
                      placeholder="name@example.invalid"
                    />
                  </label>
                  <p className="service-mail__sub-note">
                    仅检查地址格式，不代表拥有或能接收该邮箱。编辑已停用地址后会重新启用，仍需另行授权发送。
                  </p>
                  <div className="service-mail__actions">
                    <button
                      type="submit"
                      className="service-mail__button service-mail__button--primary"
                      disabled={locked || !props.recipientDraft.address.trim()}
                    >
                      保存邮箱
                    </button>
                    <button
                      type="button"
                      className="service-mail__button"
                      disabled={props.busy}
                      onClick={props.onCancelRecipientDraft}
                    >
                      取消编辑
                    </button>
                  </div>
                </form>
              )}
            </section>
            <section
              className="service-mail__panel"
              aria-labelledby="service-mail-subscription-title"
            >
              <div className="service-mail__panel-head">
                <div>
                  <h3 id="service-mail-subscription-title">
                    <span className="service-mail__step">02</span>月度订阅
                  </h3>
                  <p>一个订阅对应一个邮箱，明确授权后开启</p>
                </div>
              </div>
              <form
                className="service-mail__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  props.onEnableSubscription();
                }}
              >
                <label className="service-mail__field">
                  订阅收件邮箱
                  <select
                    value={props.subscriptionDraft.recipientId}
                    disabled={locked}
                    onChange={(event) =>
                      props.onSubscriptionDraftChange({
                        ...props.subscriptionDraft,
                        recipientId: event.target.value,
                        consent: false,
                      })
                    }
                  >
                    <option value="">选择可用邮箱</option>
                    {activeRecipients.map((recipient) => (
                      <option key={recipient.id} value={recipient.id}>
                        {recipient.address}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="service-mail__inline-fields">
                  <label className="service-mail__field">
                    每月发送日
                    <select
                      value={props.subscriptionDraft.dayOfMonth}
                      disabled={locked}
                      onChange={(event) =>
                        props.onSubscriptionDraftChange({
                          ...props.subscriptionDraft,
                          dayOfMonth: Number(event.target.value),
                          consent: false,
                        })
                      }
                    >
                      {Array.from({ length: 28 }, (_, index) => (
                        <option value={index + 1} key={index}>
                          {index + 1} 日
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="service-mail__field">
                    发送时刻
                    <select
                      value={props.subscriptionDraft.hour}
                      disabled={locked}
                      onChange={(event) =>
                        props.onSubscriptionDraftChange({
                          ...props.subscriptionDraft,
                          hour: Number(event.target.value),
                          consent: false,
                        })
                      }
                    >
                      {Array.from({ length: 24 }, (_, index) => (
                        <option value={index} key={index}>
                          {String(index).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="service-mail__field">
                  时区
                  <input
                    value={props.subscriptionDraft.timeZone}
                    maxLength={100}
                    disabled={locked}
                    onChange={(event) =>
                      props.onSubscriptionDraftChange({
                        ...props.subscriptionDraft,
                        timeZone: event.target.value,
                        consent: false,
                      })
                    }
                  />
                </label>
                <label className="service-mail__check">
                  <input
                    type="checkbox"
                    checked={props.subscriptionDraft.consent}
                    disabled={
                      locked ||
                      !providerReady ||
                      !props.subscriptionDraft.recipientId
                    }
                    onChange={(event) =>
                      props.onSubscriptionDraftChange({
                        ...props.subscriptionDraft,
                        consent: event.target.checked,
                      })
                    }
                  />
                  <span>
                    我授权向所选邮箱每月发送上一个完整月份的服务月报。自下个本地日历月起生效；每次生成当时的最新快照，零记录月份也发送。
                  </span>
                </label>
                <button
                  className="service-mail__button service-mail__button--primary"
                  type="submit"
                  disabled={
                    locked ||
                    !providerReady ||
                    !props.subscriptionDraft.consent ||
                    !props.subscriptionDraft.recipientId
                  }
                >
                  确认开启月度订阅
                </button>
              </form>
              <p className="service-mail__sub-note">
                错过计划时间超过 24
                小时会暂停，不自动补发。暂停或退订不会撤回已交付服务商的邮件。
              </p>
              {(overview?.subscriptions ?? []).map((subscription) => (
                <div
                  className="service-mail__recipient"
                  key={subscription.id}
                  style={{ marginTop: 12 }}
                >
                  <div className="service-mail__recipient-top">
                    <div>
                      <div className="service-mail__address">
                        {recipients.find(
                          (recipient) =>
                            recipient.id === subscription.recipientId,
                        )?.address ?? '历史收件地址'}
                      </div>
                      <div className="service-mail__recipient-meta">
                        每月 {subscription.dayOfMonth} 日{' '}
                        {String(subscription.hour).padStart(2, '0')}:00 ·{' '}
                        {subscription.timeZone}
                        <br />
                        修订 {subscription.revision} · 下次计划月{' '}
                        {subscription.nextDueMonth}
                      </div>
                    </div>
                    <span className="service-mail__badge">
                      {subscription.unsubscribed
                        ? '已退订'
                        : subscription.enabled
                          ? '订阅已开启'
                          : '已暂停'}
                    </span>
                  </div>
                  <div className="service-mail__actions">
                    <button
                      className="service-mail__button service-mail__button--quiet"
                      disabled={locked || !subscription.enabled}
                      onClick={() => props.onPauseSubscription(subscription)}
                    >
                      暂停订阅
                    </button>
                    <button
                      className="service-mail__button service-mail__button--quiet"
                      disabled={locked || subscription.unsubscribed}
                      onClick={() => props.onUnsubscribe(subscription)}
                    >
                      退订
                    </button>
                  </div>
                </div>
              ))}
            </section>
          </div>
          <section
            className="service-mail__panel"
            aria-labelledby="service-mail-send-title"
          >
            <div className="service-mail__panel-head">
              <div>
                <h3 id="service-mail-send-title">
                  <span className="service-mail__step">03</span>发送这份月报
                </h3>
                <p>先核对不可变快照，再提交一次发送请求</p>
              </div>
            </div>
            {props.report.state !== 'ready' ? (
              <div className="service-mail__empty">{props.report.message}</div>
            ) : (
              <div className="service-mail__notice">
                <strong>{props.report.value.month} 服务月报</strong>
                <br />
                修订 {props.report.value.reportRevision} ·{' '}
                {props.report.value.timeZone}
                <br />
                <span className="service-mail__digest">
                  快照 SHA-256：{props.report.value.snapshotSha256}
                </span>
              </div>
            )}
            <label className="service-mail__field">
              本次唯一收件邮箱
              <select
                value={props.selectedRecipientId}
                disabled={locked}
                onChange={(event) =>
                  props.onSelectRecipient(event.target.value)
                }
              >
                <option value="">选择收件邮箱</option>
                {activeRecipients.map((recipient) => (
                  <option key={recipient.id} value={recipient.id}>
                    {recipient.address} · 修订 {recipient.revision}
                  </option>
                ))}
              </select>
            </label>
            <p className="service-mail__sub-note">
              每个信封只有一个收件地址，不会把其他客户或邮箱暴露给收件人。
            </p>
            {props.sendBlockReason && (
              <div
                role="status"
                className="service-mail__notice service-mail__notice--warning"
              >
                {props.sendBlockReason}
              </div>
            )}
            {props.sendWarning && (
              <div
                role="status"
                className="service-mail__notice service-mail__notice--warning"
              >
                {props.sendWarning}
              </div>
            )}
            <div className="service-mail__actions">
              <button
                className="service-mail__button"
                disabled={
                  locked ||
                  !providerReady ||
                  !currentRecipient ||
                  props.sendBlockReason !== null ||
                  props.report.state !== 'ready'
                }
                onClick={props.onPreview}
              >
                {props.preview.state === 'loading'
                  ? '正在准备精确预览…'
                  : '生成发送预览'}
              </button>
            </div>
            {props.preview.state !== 'ready' &&
              props.preview.state !== 'unknown' && (
                <p role="status" className="service-mail__sub-note">
                  {props.preview.message}
                </p>
              )}
            {preview && (
              <div className="service-mail__preview" aria-label="精确发送预览">
                <div className="service-mail__preview-top">
                  <h4>{preview.subject}</h4>
                  <p>这份预览仅适用于以下报告、邮箱和通道版本</p>
                </div>
                <dl className="service-mail__facts">
                  <dt>收件邮箱</dt>
                  <dd>
                    {preview.confirmation.recipientAddress} · 修订{' '}
                    {preview.confirmation.recipientRevision}
                  </dd>
                  <dt>报告快照</dt>
                  <dd>
                    {preview.confirmation.report.reportId} · 修订{' '}
                    {preview.confirmation.report.reportRevision}
                  </dd>
                  <dt>报告月份</dt>
                  <dd>
                    {preview.confirmation.report.month} ·{' '}
                    {preview.confirmation.report.timeZone}
                  </dd>
                  <dt>发送方</dt>
                  <dd>{preview.provider.sender}</dd>
                  <dt>通道版本</dt>
                  <dd>{preview.confirmation.providerRegistrationRevision}</dd>
                  <dt>内容校验</dt>
                  <dd className="service-mail__digest">
                    {preview.confirmation.renderedContentSha256}
                  </dd>
                </dl>
                <ul>
                  <li>服务月报 HTML 正文和对应文本正文</li>
                  <li>
                    内容大小 {preview.envelopeBytes.toLocaleString('zh-CN')}{' '}
                    字节；无收件人阅读追踪
                  </li>
                </ul>
                <details>
                  <summary>查看完整文本正文</summary>
                  <p
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {preview.text}
                  </p>
                </details>
                <div className="service-mail__confirm">
                  <label className="service-mail__check">
                    <input
                      type="checkbox"
                      checked={props.confirmed}
                      disabled={locked || props.sendBlockReason !== null}
                      onChange={(event) =>
                        props.onConfirmChange(event.target.checked)
                      }
                    />
                    <span>
                      我已核对并授权把这一份精确月报发送给{' '}
                      {preview.confirmation.recipientAddress}
                      。仅此一封，不同时开启月度订阅。
                    </span>
                  </label>
                  <div className="service-mail__actions">
                    <button
                      className="service-mail__button service-mail__button--primary"
                      disabled={
                        locked ||
                        !props.confirmed ||
                        props.sendBlockReason !== null
                      }
                      onClick={props.onSend}
                    >
                      {preview.provider.mode === 'synthetic'
                        ? '提交模拟发送请求'
                        : '提交立即发送请求'}
                    </button>
                  </div>
                  <p className="service-mail__sub-note">
                    提交成功表示请求已保存。服务商接受与实际送达分别记录；没有送达证据时会保持“未知”。
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
        <section
          className="service-mail__panel service-mail__history"
          aria-labelledby="service-mail-history-title"
        >
          <div className="service-mail__panel-head">
            <div>
              <h3 id="service-mail-history-title">发送记录与结果</h3>
              <p>保留原收件地址和报告版本，修改邮箱不会改写历史</p>
            </div>
            <button
              className="service-mail__button"
              disabled={props.busy}
              onClick={props.onRefresh}
            >
              刷新记录
            </button>
          </div>
          {!overview?.requests.length ? (
            <div className="service-mail__empty">
              当前读取范围内还没有发送请求
            </div>
          ) : (
            <ol className="service-mail__timeline">
              {overview.requests.map((request) => (
                <li className="service-mail__history-row" key={request.id}>
                  <span className="service-mail__dot" aria-hidden="true" />
                  <div>
                    <strong>
                      {request.confirmation.report.month} ·{' '}
                      {request.confirmation.recipientAddress}
                    </strong>
                    <div className="service-mail__history-meta">
                      <span>{requestLabel(request)}</span>
                      <span>{request.createdAt}</span>
                      <span>尝试 {request.attemptCount} 次</span>
                    </div>
                    <p>
                      {request.delivery === 'confirmed-delivered' &&
                      !request.simulated
                        ? '已收到独立送达证据'
                        : '实际送达：未知'}
                      {request.blockedReason
                        ? ` · ${reasonLabels[request.blockedReason] ?? '当前条件不满足'}`
                        : ''}
                      {request.cancellationRequested &&
                      request.state !== 'cancelled-before-dispatch'
                        ? ' · 已请求取消，不能承诺撤回在途邮件'
                        : ''}
                    </p>
                    <p className="service-mail__digest">
                      请求 {request.id} · 快照{' '}
                      {request.confirmation.report.snapshotSha256}
                    </p>
                  </div>
                  <div className="service-mail__actions">
                    {[
                      'dispatching',
                      'outcome-unknown',
                      'provider-accepted',
                    ].includes(request.state) && (
                      <button
                        className="service-mail__button"
                        disabled={locked}
                        onClick={() => props.onReconcileRequest(request.id)}
                      >
                        核对服务商结果
                      </button>
                    )}
                    {[
                      'queued',
                      'blocked',
                      'dispatching',
                      'outcome-unknown',
                    ].includes(request.state) &&
                      !request.cancellationRequested && (
                        <button
                          className="service-mail__button service-mail__button--warning"
                          disabled={locked}
                          onClick={() =>
                            props.onCancelRequest(request.id, request.revision)
                          }
                        >
                          请求取消发送
                        </button>
                      )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {overview?.truncated && (
            <p className="service-mail__sub-note">
              本次只读取有界的一部分记录，不代表全部历史。新预览与提交仍需服务器重新检查更早的未确认请求。
            </p>
          )}
          {(overview?.occurrences ?? [])
            .filter((occurrence) => occurrence.state === 'blocked')
            .map((occurrence) => (
              <p key={occurrence.id} className="service-mail__sub-note">
                {occurrence.reportMonth} 订阅任务未发送：
                {occurrence.blockedReason
                  ? reasonLabels[occurrence.blockedReason]
                  : '等待重新确认'}
                。不会自动补发。
              </p>
            ))}
        </section>
        <p className="service-mail__footer">
          邮箱格式检查不等于归属验证。邮件记录不会自动转化为“客户已阅读”“已参会”或“服务已送达”的业务事实。
        </p>
      </div>
    </section>
  );
}
