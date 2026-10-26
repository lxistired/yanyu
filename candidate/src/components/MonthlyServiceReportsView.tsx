// NEW controlled presentation after reset. No requests, storage, journal or authority owner lives here.
import { useId, useState } from 'react';
import type { ReaderSourcePin } from '../../shared/reader-reference';
import {
  SERVICE_ACTIVITY_KINDS,
  SERVICE_ACTIVITY_STATUSES,
  SERVICE_REPORT_LIMITS,
  type ServiceActivity,
  type ServiceActivityInput,
  type ServiceActivityKind,
  type ServiceActivityStatus,
  type ServiceCustomer,
  type ServiceMonth,
  type ServiceReport,
} from '../../shared/service-reports';
import type {
  MonthlyServiceReportsViewProps,
  ServiceActivityDraft,
  ServicePageRequest,
  ServiceReadState,
  ServiceSourceOpenRequest,
} from './service-report-view-types';
import './monthly-service-reports.css';

export type { MonthlyServiceReportsViewProps } from './service-report-view-types';
const FIRST_PAGE: ServicePageRequest = { after: null, censusSha256: null };
const kindNames: Record<ServiceActivityKind, string> = {
  'content-read': '资料阅读（用户记录）',
  meeting: '会议（用户记录）',
  call: '电话（用户记录）',
  email: '邮件（用户记录）',
  'research-support': '研究支持（用户记录）',
  other: '其他服务（用户记录）',
};
const statusNames: Record<ServiceActivityStatus, string> = {
  planned: '计划中',
  'reported-completed': '用户报告已完成',
  cancelled: '已取消',
};
const customerKey = (customer: ServiceCustomer) =>
  JSON.stringify([customer.organizationId, customer.contactId]);
const sameCustomer = (a: ServiceCustomer | null, b: ServiceCustomer) =>
  a !== null && customerKey(a) === customerKey(b);
const pinKey = (pin: ReaderSourcePin) =>
  JSON.stringify([pin.documentId, pin.revisionId, pin.tenantId, pin.collectionId, pin.sha256]);
const sourceKey = (pin: ReaderSourcePin) => JSON.stringify([pin.documentId, pin.revisionId]);

function validText(value: string, max: number): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= max &&
    !Array.from(value).some(
      (character) =>
        (character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0))) ||
        character.charCodeAt(0) === 127,
    ) &&
    !/[\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  );
}
function validPin(pin: ReaderSourcePin): boolean {
  return (
    validText(pin.documentId, 500) &&
    validText(pin.revisionId, 500) &&
    validText(pin.tenantId, 100) &&
    validText(pin.collectionId, 500) &&
    /^[a-f0-9]{64}$/u.test(pin.sha256)
  );
}
function validInstant(value: string): boolean {
  return (
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function canonicalZone(value: string): string | null {
  if (value.length > 100 || !(value === 'UTC' || /^[A-Za-z_+-]+\/[A-Za-z0-9_+/-]+$/u.test(value)))
    return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
function validMonth(value: string): boolean {
  return (
    /^\d{4}-(0[1-9]|1[0-2])$/u.test(value) &&
    Number(value.slice(0, 4)) >= 1970 &&
    Number(value.slice(0, 4)) <= 9998
  );
}
/** Presentation-only validation. Host/server still validate every callback and current permission. */
function draftProblems(
  draft: ServiceActivityDraft,
  choices: ServiceReadState<readonly ReaderSourcePin[]>,
  customer: ServiceCustomer | null,
): string[] {
  const value = draft.activity,
    problems: string[] = [];
  const customerMatches =
    sameCustomer(customer, value.customer) ||
    (draft.mode === 'correct' &&
      customer?.organizationId === value.customer.organizationId &&
      customer.contactId === null);
  if (!customerMatches) problems.push('草稿客户与当前选择不一致，请取消后重新记录。');
  if (!SERVICE_ACTIVITY_KINDS.includes(value.kind) || !SERVICE_ACTIVITY_STATUSES.includes(value.status))
    problems.push('请选择有效的活动类型与记录状态。');
  if (!validInstant(value.occurredAt))
    problems.push('时间须为精确 UTC 格式，例如 2026-10-03T09:15:00.000Z。');
  if (!validText(value.summary, 1000)) problems.push('请填写 1 至 1000 字的自述摘要，不得包含无效控制字符。');
  if (draft.mode === 'correct' && !validText(draft.reason, 500))
    problems.push('更正须填写 1 至 500 字的原因；原版本会保留。');
  if (value.references.length < 1 || value.references.length > SERVICE_REPORT_LIMITS.sourcesPerActivity)
    problems.push(`每条活动须选择 1 至 ${SERVICE_REPORT_LIMITS.sourcesPerActivity} 个已核验的精确来源。`);
  if (new Set(value.references.map(({ pin }) => sourceKey(pin))).size !== value.references.length)
    problems.push('同一文档与修订不能重复引用。');
  if (
    value.references.length > 0 &&
    (choices.state !== 'ready' ||
      value.references.some(
        ({ pin }) =>
          !validPin(pin) ||
          !choices.value.some((choice) => validPin(choice) && pinKey(choice) === pinKey(pin)),
      ))
  )
    problems.push('所选来源尚未在当前选项中逐一核验，请重新核验完整来源标识。');
  return problems;
}

function ReadNotice({ read, label }: { read: ServiceReadState<unknown>; label: string }) {
  if (read.state === 'ready') return null;
  const suffix = {
    loading: '正在载入',
    unknown: '尚未确认',
    unavailable: '当前不可用',
    error: '读取失败',
  }[read.state];
  return (
    <p className="sr-notice" role={read.state === 'error' ? 'alert' : 'status'}>
      <span>
        {label}
        {suffix}：
      </span>
      {read.message}
    </p>
  );
}
function SourceIdentity({ pin }: { pin: ReaderSourcePin }) {
  return (
    <details className="sr-disclosure sr-source-details">
      <summary>查看精确来源标识</summary>
      <div className="sr-source-identity">
        <span>
          文档 {pin.documentId} · 版本 {pin.revisionId}
        </span>
        <span>
          租户 {pin.tenantId} · 集合 {pin.collectionId}
        </span>
        <span className="sr-monospace">SHA-256 {pin.sha256}</span>
      </div>
    </details>
  );
}
function TimeRules({ period }: { period: ServiceMonth }) {
  return (
    <details className="sr-disclosure">
      <summary>时间规则与参考点</summary>
      <dl className="sr-facts">
        <div>
          <dt>月份与时区</dt>
          <dd>
            {period.month} · {period.timeZone}
          </dd>
        </div>
        <div>
          <dt>归属规则</dt>
          <dd>按所选时区的本地日历年与月归属</dd>
        </div>
        <div>
          <dt>时区数据库版本</dt>
          <dd>{period.tzdbVersion}</dd>
        </div>
        <div>
          <dt>本月首个瞬间</dt>
          <dd className="sr-monospace">{period.utcMarkers.firstInstantOfMonth}</dd>
        </div>
        <div>
          <dt>下月首个瞬间</dt>
          <dd className="sr-monospace">{period.utcMarkers.firstInstantOfFollowingMonth}</dd>
        </div>
      </dl>
      <p>这些参考点不构成用于筛选记录的连续 UTC 区间。</p>
    </details>
  );
}
function ActivityRecord({
  activity,
  report,
  disabled,
  openingSource,
  onOpenSource,
  onCorrect,
  onArchive,
}: {
  activity: ServiceActivity;
  report?: ServiceReport;
  disabled: boolean;
  openingSource: boolean;
  onOpenSource: (request: ServiceSourceOpenRequest, opener: HTMLButtonElement) => void;
  onCorrect?: () => void;
  onArchive?: () => void;
}) {
  const { value } = activity.version;
  return (
    <article className="sr-record" aria-label={`活动 ${activity.id}`}>
      <div className="sr-row-heading">
        <h3>{kindNames[value.kind]}</h3>
        <span className="sr-badge">{statusNames[value.status]}</span>
      </div>
      <p className="sr-summary">{value.summary}</p>
      {value.ordinarySource && <p className="sr-muted">机构服务记录投影 · {value.ordinarySource.id} · 源修订 {value.ordinarySource.revision}（原始快照保留，未验证服务成效）</p>}
      <p className="sr-muted">
        <time dateTime={value.occurredAt}>{value.occurredAt}</time> · UTC
      </p>
      <p className="sr-muted">用户自行记录；不核验客户阅读、出席、实际送达或服务成效</p>
      {activity.archivedAt !== null && <p className="sr-notice">已归档：{activity.archivedAt}</p>}
      <details className="sr-disclosure">
        <summary>活动版本与记录来源</summary>
        <dl className="sr-facts">
          <div>
            <dt>活动标识</dt>
            <dd>{activity.id}</dd>
          </div>
          <div>
            <dt>状态修订 / 内容版本</dt>
            <dd>
              {activity.revision} / {activity.versionId}
            </dd>
          </div>
          <div>
            <dt>记录序号</dt>
            <dd>{activity.version.sequence}</dd>
          </div>
          <div>
            <dt>记录人 / 时间</dt>
            <dd>
              {activity.version.recordedBySubject} · {activity.version.recordedAt}
            </dd>
          </div>
          <div>
            <dt>记录时客户</dt>
            <dd>
              {value.customer.organizationId} · {value.customer.contactId ?? '机构级记录'}
            </dd>
          </div>
          <div>
            <dt>客户修订</dt>
            <dd>
              机构 {activity.version.customerAtRecord.organizationRevision} · 联系人{' '}
              {activity.version.customerAtRecord.contactRevision ?? '不适用'}
            </dd>
          </div>
        </dl>
        {activity.version.correction && (
          <p>
            更正自 {activity.version.correction.previousVersionId}：{activity.version.correction.reason}
          </p>
        )}
      </details>
      <ul className="sr-source-list" aria-label="活动的精确来源">
        {value.references.map(({ pin }, referenceIndex) => (
          <li key={`${referenceIndex}:${pinKey(pin)}`}>
            <p className="sr-source-label">来源 {referenceIndex + 1} · 固定版本</p>
            <SourceIdentity pin={pin} />
            <button
              type="button"
              className="sr-button"
              aria-label={`打开来源 ${pin.documentId} · 版本 ${pin.revisionId}`}
              disabled={true} title="此组合尚未接入来源打开"
              onClick={(event) => {
                if (disabled || openingSource) return;
                const base = {
                  activityId: activity.id,
                  versionId: activity.versionId,
                  referenceIndex,
                  pin,
                  expectedRevision: report?.revision ?? activity.revision,
                };
                onOpenSource(
                  report ? { ...base, from: 'report', reportId: report.id } : { ...base, from: 'activity' },
                  event.currentTarget,
                );
              }}
            >
              打开来源 {referenceIndex + 1}
            </button>
          </li>
        ))}
      </ul>
      {(onCorrect || onArchive) && (
        <div className="sr-actions">
          {onCorrect && (
            <button
              type="button"
              className="sr-button"
              disabled={disabled || activity.archivedAt !== null}
              onClick={() => {
                if (!disabled && activity.archivedAt === null) onCorrect();
              }}
            >
              更正此活动
            </button>
          )}
          {onArchive && (
            <button
              type="button"
              className="sr-button"
              disabled={disabled}
              onClick={() => {
                if (!disabled) onArchive();
              }}
            >
              {activity.archivedAt === null ? '归档此活动' : '取消归档此活动'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function ActivityEditor({ props, disabled }: { props: MonthlyServiceReportsViewProps; disabled: boolean }) {
  const id = useId(),
    draft = props.draft;
  if (draft === null) return null;
  const problems = draftProblems(draft, props.sourceChoices, props.selection.customer);
  const update = (change: Partial<ServiceActivityInput>) => {
    if (!disabled)
      props.onDraftChange({
        ...draft,
        activity: { ...draft.activity, ...change },
      });
  };
  const readyChoices = props.sourceChoices.state === 'ready' ? props.sourceChoices.value : [];
  const choices = readyChoices.filter(
    (pin, index) =>
      validPin(pin) &&
      readyChoices.findIndex((candidate) => sourceKey(candidate) === sourceKey(pin)) === index,
  );
  return (
    <section
      className="sr-panel sr-editor"
      aria-label={draft.mode === 'add' ? '记录服务活动' : '更正服务活动'}
    >
      <h2>{draft.mode === 'add' ? '记录服务活动' : '更正服务活动'}</h2>
      <p>这里保存你的明确记录，不核验客户阅读、出席、实际送达或服务成效。</p>
      {draft.mode === 'correct' && (
        <p className="sr-notice">
          更正会保留原版本 {draft.previousVersionId}
          ，新增一个内容版本；已生成月报不会随之改写。
        </p>
      )}
      <form
        aria-label="活动草稿"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && problems.length === 0) props.onSubmitActivity(draft);
        }}
      >
        <fieldset className="sr-fieldset" disabled={disabled}>
          <legend>活动内容</legend>
          <div className="sr-form-grid">
            <label className="sr-field">
              活动类型
              <select
                value={draft.activity.kind}
                onChange={(event) => update({ kind: event.target.value as ServiceActivityKind })}
              >
                {SERVICE_ACTIVITY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kindNames[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="sr-field">
              记录状态
              <select
                value={draft.activity.status}
                onChange={(event) =>
                  update({
                    status: event.target.value as ServiceActivityStatus,
                  })
                }
              >
                {SERVICE_ACTIVITY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusNames[status]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="sr-field">
            活动时间（UTC，含毫秒）
            <input
              type="text"
              value={draft.activity.occurredAt}
              maxLength={24}
              placeholder="2026-10-03T09:15:00.000Z"
              aria-invalid={!validInstant(draft.activity.occurredAt)}
              aria-describedby={`${id}-problems`}
              onChange={(event) => update({ occurredAt: event.target.value })}
            />
          </label>
          <label className="sr-field">
            自述摘要
            <textarea
              value={draft.activity.summary}
              maxLength={1000}
              rows={4}
              aria-describedby={`${id}-problems`}
              onChange={(event) => update({ summary: event.target.value })}
            />
          </label>
          <p className="sr-muted">
            {draft.activity.summary.length} / 1000 字。摘要是你的注释，不会被标记为原文摘录。
          </p>
          {draft.mode === 'correct' && (
            <label className="sr-field">
              更正原因
              <textarea
                rows={2}
                value={draft.reason}
                maxLength={500}
                onChange={(event) => {
                  if (!disabled)
                    props.onDraftChange({
                      ...draft,
                      reason: event.target.value,
                    });
                }}
              />
            </label>
          )}
        </fieldset>
        <fieldset className="sr-fieldset" disabled={disabled}>
          <legend>精确来源（必选 1–8 个）</legend>
          <p className="sr-muted">仅使用下方核验过的原件标识。文档名、修订名或相同标题不能替代完整标识。</p>
          <ReadNotice read={props.sourceChoices} label="来源选项" />
          <div className="sr-source-choices">
            {choices.map((pin, sourceIndex) => {
              const checked = draft.activity.references.some(
                (reference) => pinKey(reference.pin) === pinKey(pin),
              );
              const duplicate = draft.activity.references.some(
                (reference) =>
                  sourceKey(reference.pin) === sourceKey(pin) && pinKey(reference.pin) !== pinKey(pin),
              );
              return (
                <div className="sr-source-choice" key={pinKey(pin)}>
                  <label className="sr-source-choice-label">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={
                        disabled ||
                        (!checked &&
                          (draft.activity.references.length >= SERVICE_REPORT_LIMITS.sourcesPerActivity ||
                            duplicate))
                      }
                      aria-label={`引用来源 ${pin.documentId} · 版本 ${pin.revisionId} · 租户 ${pin.tenantId} · 集合 ${pin.collectionId} · SHA-256 ${pin.sha256}`}
                      onChange={(event) => {
                        if (disabled) return;
                        const next = event.target.checked
                          ? [...draft.activity.references, { pin }]
                          : draft.activity.references.filter(
                              (reference) => pinKey(reference.pin) !== pinKey(pin),
                            );
                        if (next.length <= SERVICE_REPORT_LIMITS.sourcesPerActivity)
                          update({ references: next });
                      }}
                    />
                    <span>来源 {sourceIndex + 1} · 固定版本</span>
                  </label>
                  <SourceIdentity pin={pin} />
                </div>
              );
            })}
          </div>
          {props.sourceChoices.state === 'ready' && choices.length === 0 && (
            <p>当前没有已核验的来源选项，请在下方核验原件。</p>
          )}
          {draft.activity.references.map(
            ({ pin }, index) =>
              !choices.some((choice) => pinKey(choice) === pinKey(pin)) && (
                <div className="sr-retained-source" key={`${index}:${pinKey(pin)}`}>
                  <p>草稿保留的引用尚未重新核验</p>
                  <SourceIdentity pin={pin} />
                  <button
                    type="button"
                    className="sr-button"
                    disabled={disabled}
                    onClick={() =>
                      update({
                        references: draft.activity.references.filter((_, i) => i !== index),
                      })
                    }
                  >
                    移除未核验引用 {index + 1}
                  </button>
                </div>
              ),
          )}
          <button
            type="button"
            className="sr-button"
            disabled={disabled || props.sourceChoices.state === 'loading'}
            onClick={() => {
              if (!disabled && props.sourceChoices.state !== 'loading') props.onRefreshSources();
            }}
          >
            重新核验来源选项
          </button>
        </fieldset>
        <div id={`${id}-problems`} className="sr-validation" aria-live="polite">
          {problems.length > 0 ? (
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : (
            <p>必填内容已填写；提交时仍会核验当前权限与原件。</p>
          )}
        </div>
        <div className="sr-actions">
          <button type="submit" className="sr-button sr-primary" disabled={disabled || problems.length > 0}>
            {draft.mode === 'add' ? '保存活动记录' : '保存更正记录'}
          </button>
          <button
            type="button"
            className="sr-button"
            disabled={disabled}
            onClick={() => {
              if (!disabled) props.onCancelDraft();
            }}
          >
            取消草稿
          </button>
        </div>
      </form>
    </section>
  );
}

function ReportSnapshot({
  report,
  props,
  disabled,
  canReplace,
}: {
  report: ServiceReport;
  props: MonthlyServiceReportsViewProps;
  disabled: boolean;
  canReplace: boolean;
}) {
  const { snapshot } = report;
  return (
    <section className="sr-panel sr-snapshot" aria-label="月报快照">
      <div className="sr-row-heading">
        <div>
          <p className="sr-eyebrow">不可变派生快照</p>
          <h2>{snapshot.period.month} 服务月报</h2>
        </div>
        <button type="button" className="sr-button" onClick={props.onCloseReport}>
          关闭月报详情
        </button>
      </div>
      <p>
        月报 {report.id} · 状态修订 {report.revision}
      </p>
      <p className="sr-notice">
        这是用户记录的派生汇总，不是原始证据，也不核验客户阅读、出席、外部送达或服务成效。
      </p>
      <p className="sr-muted">
        客户 {snapshot.customer.organizationId} · {snapshot.customer.contactId ?? '机构级汇总'} · 生成于{' '}
        {snapshot.generatedAt}
      </p>
      {report.currentActivitiesChanged && (
        <p role="status" className="sr-warning">
          当前活动已变化。此月报仍显示生成时内容；如需更新，请在相同客户、月份与时区下生成替代快照。
        </p>
      )}
      {report.state.archivedAt !== null && (
        <p className="sr-notice">此月报已归档：{report.state.archivedAt}</p>
      )}
      {report.state.supersededByReportId !== null && (
        <p className="sr-notice">此月报已被 {report.state.supersededByReportId} 替代；原快照仍保留。</p>
      )}
      {snapshot.supersedesReportId !== null && <p>替代的原月报：{snapshot.supersedesReportId}</p>}
      <section className="sr-totals" aria-label="生成时用户记录汇总">
        <div className="sr-total">
          <span>用户记录总数</span>
          <strong>{snapshot.totals.totalRecords}</strong>
          <span>仅限此快照</span>
        </div>
        <dl className="sr-counts">
          {SERVICE_ACTIVITY_STATUSES.map((status) => (
            <div key={status}>
              <dt>{statusNames[status]}</dt>
              <dd>{snapshot.totals.byStatus[status]}</dd>
            </div>
          ))}
        </dl>
        <dl className="sr-counts">
          {SERVICE_ACTIVITY_KINDS.map((kind) => (
            <div key={kind}>
              <dt>{kindNames[kind]}</dt>
              <dd>{snapshot.totals.byKind[kind]}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="sr-muted">客户阅读：未核验 · 客户出席：未核验 · 外部送达：未核验</p>
      <details className="sr-disclosure">
        <summary>快照标识与校验值</summary>
        <p className="sr-monospace">快照 SHA-256 {report.snapshotSha256}</p>
        <p className="sr-monospace">活动依据 SHA-256 {snapshot.basisSha256}</p>
        <p>生成者 {snapshot.generatedBySubject}</p>
        <p>
          生成时客户修订：机构 {snapshot.customerAtGeneration.organizationRevision} · 联系人{' '}
          {snapshot.customerAtGeneration.contactRevision ?? '不适用'}
        </p>
        <p>派生类型：derived-artifact · derived-user-recorded-service-summary</p>
        <p>本次本地读取核验时间：{report.authorization.checkedAt}</p>
        <p>校验值用于标识保存的内容，不证明客户行为或外部送达。</p>
      </details>
      <TimeRules period={snapshot.period} />
      <div className="sr-export">
        <h3>导出当前可授权的快照</h3>
        <p>
          每次下载均重新请求当前权限下的导出。HTML
          为静态惰性文件；导出不包含原件正文。已下载的副本无法随原件撤回。
        </p>
        <div className="sr-actions">
          {(['json', 'csv', 'html'] as const).map((format) => (
            <button
              key={format}
              type="button"
              className="sr-button"
              disabled={disabled || props.exporting !== null}
              onClick={() => {
                if (!disabled && props.exporting === null)
                  props.onExportReport({
                    reportId: report.id,
                    expectedRevision: report.revision,
                    format,
                  });
              }}
            >
              {format === 'html' ? '下载 静态 HTML' : `下载 ${format.toUpperCase()}`}
            </button>
          ))}
        </div>
        {props.exporting?.reportId === report.id && (
          <p role="status">
            正在重新核验并准备 {props.exporting.format.toUpperCase()} 下载，请等待当前请求。
          </p>
        )}
      </div>
      <div className="sr-actions">
        <button
          type="button"
          className="sr-button"
          disabled={
            disabled ||
            !canReplace ||
            report.state.archivedAt !== null ||
            report.state.supersededByReportId !== null
          }
          onClick={() => {
            if (
              disabled ||
              !canReplace ||
              report.state.archivedAt !== null ||
              report.state.supersededByReportId !== null
            )
              return;
            props.onCreateReport({
              customer: snapshot.customer,
              month: snapshot.period.month,
              timeZone: snapshot.period.timeZone,
              supersedes: { id: report.id, expectedRevision: report.revision },
            });
          }}
        >
          生成替代月报快照
        </button>
        <button
          type="button"
          className="sr-button"
          disabled={disabled}
          onClick={() => {
            if (!disabled)
              props.onArchiveReport({
                id: report.id,
                expectedRevision: report.revision,
                archived: report.state.archivedAt === null,
              });
          }}
        >
          {report.state.archivedAt === null ? '归档此月报' : '取消归档此月报'}
        </button>
      </div>
      {!canReplace && (
        <p className="sr-muted">替代快照需要载入相同客户、月份与时区的当前活动，并先结束草稿。</p>
      )}
      <h3>生成时保存的活动（{snapshot.activities.length}）</h3>
      {snapshot.activities.length === 0 && <p>此快照保存了零条用户活动记录；这不代表没有发生服务。</p>}
      <div className="sr-records">
        {snapshot.activities.map((activity) => (
          <ActivityRecord
            key={activity.id}
            activity={activity}
            report={report}
            disabled={disabled}
            openingSource={props.openingSource}
            onOpenSource={props.onOpenSource}
          />
        ))}
      </div>
    </section>
  );
}

export function MonthlyServiceReportsView(props: MonthlyServiceReportsViewProps) {
  const overviewId = useId();
  const [emptyActivitiesExpanded, setEmptyActivitiesExpanded] = useState(false);
  const [emptyReportsExpanded, setEmptyReportsExpanded] = useState(false);
  const { authority, selection, pending } = props;
  const available = authority.state === 'available';
  const locked = !available || pending !== null;
  const selectionLocked = locked || props.draft !== null;
  const validSelection =
    selection.customer !== null && validMonth(selection.month) && canonicalZone(selection.timeZone) !== null;
  // These are display guards, not an independent authorization decision. The host supplies every read.
  const activities =
    available &&
    props.activities.read.state === 'ready' &&
    props.activities.read.value.scope === authority.scope
      ? props.activities.read.value
      : null;
  const reportCards =
    available &&
    props.reportCards.read.state === 'ready' &&
    props.reportCards.read.value.scope === authority.scope
      ? props.reportCards.read.value
      : null;
  const currentPeriod =
    activities !== null &&
    activities.period.month === selection.month &&
    canonicalZone(activities.period.timeZone) === canonicalZone(selection.timeZone);
  const canGenerate = !selectionLocked && validSelection && currentPeriod;
  const report = available && props.selectedReport.state === 'ready' ? props.selectedReport.value : null;
  const canReplace =
    canGenerate &&
    report !== null &&
    sameCustomer(selection.customer, report.snapshot.customer) &&
    selection.month === report.snapshot.period.month &&
    canonicalZone(selection.timeZone) === canonicalZone(report.snapshot.period.timeZone);
  const choices = available && props.customerChoices.state === 'ready' ? props.customerChoices.value : [];
  const selectedKey = selection.customer ? customerKey(selection.customer) : '';
  const selectionInPage = choices.some((choice) => customerKey(choice.pin) === selectedKey);
  // Only an explicitly ready, empty page can be compacted. Errors and recovery stay exposed.
  const compactEmptyActivities =
    props.draft !== null && activities?.items.length === 0 && !props.activities.resetNotice;
  const compactEmptyReports =
    props.draft !== null && reportCards?.items.length === 0 && !props.reportCards.resetNotice;
  return (
    <main className="sr-workspace" aria-label="服务月报">
      <header className="sr-heading">
        <div>
          <p className="sr-eyebrow">客户服务 / 明确记录</p>
          <h1>服务月报</h1>
          <p>保留活动的精确来源，按本地日历月份生成可追溯的派生快照。</p>
        </div>
        <p
          className={`sr-authority${available ? ' sr-authority-ready' : ''}`}
          role="status"
          aria-label="访问状态"
        >
          {available
            ? '当前本地权限可用'
            : authority.state === 'unknown'
              ? '当前访问范围尚未确认'
              : '当前访问不可用'}
          <span>{authority.message}</span>
        </p>
      </header>
      <p className="sr-notice">
        所有数量均来自用户明确保存的服务记录，不推断客户阅读、出席、外部送达或服务成效。
      </p>
      {pending && (
        <section className="sr-pending" role="status" aria-label="待确认操作">
          <h2>{pending.phase === 'sending' ? '正在确认原操作' : '原操作结果尚未确认'}</h2>
          <p>
            {pending.label}：{pending.message}
          </p>
          <p>原内容与操作标识仍保留。检查未找到结果也不代表未提交；请先解决这条操作，不能另建操作替代它。</p>
          <p>
            取消只会阻止尚未提交的原操作；已经提交的更改仍然保留，不会撤销。确认取消后将关闭旧草稿并重新读取当前记录。
          </p>
          <details className="sr-disclosure">
            <summary>原操作标识</summary>
            <p className="sr-monospace">{pending.token}</p>
          </details>
          <div className="sr-actions">
            <button
              type="button"
              className="sr-button"
              disabled={!available || pending.phase === 'sending' || !pending.canCheck}
              onClick={() => {
                if (available && pending.phase !== 'sending' && pending.canCheck)
                  props.onCheckPending(pending.token);
              }}
            >
              检查原操作结果
            </button>
            <button
              type="button"
              className="sr-button"
              disabled={!available || pending.phase === 'sending' || !pending.canRetrySame}
              onClick={() => {
                if (available && pending.phase !== 'sending' && pending.canRetrySame)
                  props.onRetryPending(pending.token);
              }}
            >
              使用原内容重试
            </button>
            <button
              type="button"
              className="sr-button"
              disabled={!available || pending.phase === 'sending' || !pending.canCancel}
              onClick={() => {
                if (available && pending.phase !== 'sending' && pending.canCancel)
                  props.onCancelPending(pending.token);
              }}
            >
              取消未提交的原操作
            </button>
          </div>
        </section>
      )}
      {props.mutationError && (
        <p role="alert" className="sr-error">
          操作未确认：{props.mutationError}
          。请检查当前状态；不要把错误当作未提交。
        </p>
      )}
      {props.sourceError && (
        <p role="alert" className="sr-error">
          来源打开或核验失败：{props.sourceError}
        </p>
      )}
      {props.exportError && (
        <p role="alert" className="sr-error">
          月报下载失败：{props.exportError}
          。请重新请求下载，不要使用先前生成的内容。
        </p>
      )}
      <section className="sr-panel" aria-label="客户与月份选择">
        <h2>选择本月服务范围</h2>
        <div className="sr-form-grid sr-selection">
          <label className="sr-field">
            客户
            <select
              value={available ? selectedKey : ''}
              disabled={selectionLocked || props.customerChoices.state !== 'ready'}
              onChange={(event) => {
                if (selectionLocked || props.customerChoices.state !== 'ready') return;
                const choice = choices.find((entry) => customerKey(entry.pin) === event.target.value);
                if (choice || event.target.value === '')
                  props.onSelectionChange({
                    ...selection,
                    customer: choice
                      ? {
                          organizationId: choice.pin.organizationId,
                          contactId: choice.pin.contactId,
                        }
                      : null,
                  });
              }}
            >
              <option value="">请选择当前 CRM 客户</option>
              {available && selection.customer && !selectionInPage && (
                <option value={selectedKey}>
                  当前选择（不在本页）：{selection.customer.organizationId} ·{' '}
                  {selection.customer.contactId ?? '机构级汇总'}
                </option>
              )}
              {choices.map((choice) => (
                <option key={customerKey(choice.pin)} value={customerKey(choice.pin)}>
                  {choice.organizationName}
                  {choice.contactName === null ? ' · 机构级汇总' : ` · ${choice.contactName}`}
                </option>
              ))}
            </select>
          </label>
          <label className="sr-field">
            月份
            <input
              type="month"
              min="1970-01"
              max="9998-12"
              value={selection.month}
              disabled={selectionLocked}
              onChange={(event) => {
                if (!selectionLocked)
                  props.onSelectionChange({
                    ...selection,
                    month: event.target.value,
                  });
              }}
            />
          </label>
          <label className="sr-field">
            IANA 时区
            <input
              type="text"
              value={selection.timeZone}
              maxLength={100}
              placeholder="Asia/Shanghai"
              disabled={selectionLocked}
              onChange={(event) => {
                if (!selectionLocked)
                  props.onSelectionChange({
                    ...selection,
                    timeZone: event.target.value,
                  });
              }}
            />
          </label>
        </div>
        <label className="sr-check">
          <input
            type="checkbox"
            checked={selection.includeArchived}
            disabled={selectionLocked}
            onChange={(event) => {
              if (!selectionLocked)
                props.onSelectionChange({
                  ...selection,
                  includeArchived: event.target.checked,
                });
            }}
          />
          显示已归档记录与月报
        </label>
        {available && <ReadNotice read={props.customerChoices} label="CRM 客户选项" />}
        <p className="sr-muted">
          客户名称来自当前 CRM 页；机构级汇总可包含该机构的联系人记录。选项和活动页均不是完整清单。
        </p>
        {!validSelection && available && (
          <p role="status">请选择客户、1970–9998 年的有效月份及有效 IANA 时区。</p>
        )}
        {props.draft !== null && available && (
          <p role="status">请先保存或取消活动草稿，再切换范围或读取列表。</p>
        )}
        <div className="sr-actions">
          <button
            type="button"
            className="sr-button"
            disabled={selectionLocked}
            onClick={() => {
              if (!selectionLocked) props.onRefreshCustomers();
            }}
          >
            刷新客户选项
          </button>
          <button
            type="button"
            className="sr-button"
            disabled={selectionLocked || !validSelection || props.activities.read.state === 'loading'}
            onClick={() => {
              if (!selectionLocked && validSelection && props.activities.read.state !== 'loading')
                props.onActivitiesPage({ ...FIRST_PAGE });
            }}
          >
            载入本月活动
          </button>
          <button
            type="button"
            className="sr-button sr-primary"
            disabled={!canGenerate}
            onClick={() => {
              if (canGenerate && selection.customer)
                props.onCreateReport({
                  customer: selection.customer,
                  month: selection.month,
                  timeZone: selection.timeZone,
                  supersedes: null,
                });
            }}
          >
            生成不可变月报快照
          </button>
        </div>
        <p className="sr-muted">
          生成时由服务重新读取完整符合条件的未归档活动，最多 {SERVICE_REPORT_LIMITS.activitiesPerReport}{' '}
          条；不会仅汇总当前页，也不会修改已有快照。
        </p>
      </section>
      <div className="sr-recording-layout">
        <div className="sr-columns">
          <section
            className={`sr-panel${compactEmptyActivities ? ' sr-empty-overview' : ''}`}
            data-expanded={emptyActivitiesExpanded}
            aria-label="本月用户记录"
            aria-busy={available && props.activities.read.state === 'loading'}
          >
            <div className="sr-row-heading">
              <h2>本月用户记录</h2>
              <button
                type="button"
                className="sr-button"
                disabled={selectionLocked || !validSelection || !currentPeriod}
                onClick={() => {
                  if (!selectionLocked && validSelection && currentPeriod) props.onBeginActivity();
                }}
              >
                记录活动
              </button>
            </div>
            {compactEmptyActivities && (
              <button
                type="button"
                className="sr-button sr-overview-toggle"
                aria-expanded={emptyActivitiesExpanded}
                aria-controls={`${overviewId}-empty-activities`}
                onClick={() => setEmptyActivitiesExpanded((expanded) => !expanded)}
              >
                {emptyActivitiesExpanded ? '收起空活动页详情与分页' : '当前页暂无活动 · 展开详情与分页'}
              </button>
            )}
            <div id={`${overviewId}-empty-activities`} className="sr-overview-body">
              {!available ? (
                <p role="status">活动列表当前不可用：请先确认当前访问范围。</p>
              ) : (
                <ReadNotice read={props.activities.read} label="活动列表" />
              )}
              {available && props.activities.resetNotice && (
                <p role="status" className="sr-warning">
                  {props.activities.resetNotice}
                </p>
              )}
              {activities && (
                <>
                  <p className="sr-muted">
                    当前页 {activities.items.length} 条，不代表本月全部活动或服务次数。
                  </p>
                  {activities.items.length === 0 && (
                    <p>当前页没有符合条件的用户记录。未载入或不可用不等于零条记录。</p>
                  )}
                  <div className="sr-records">
                    {activities.items.map((activity) => (
                      <ActivityRecord
                        key={activity.id}
                        activity={activity}
                        disabled={selectionLocked}
                        openingSource={props.openingSource}
                        onOpenSource={props.onOpenSource}
                        onCorrect={() => props.onCorrectActivity(activity)}
                        onArchive={() =>
                          props.onArchiveActivity({
                            id: activity.id,
                            expectedRevision: activity.revision,
                            archived: activity.archivedAt === null,
                          })
                        }
                      />
                    ))}
                  </div>
                </>
              )}
              <nav className="sr-actions sr-pagination" aria-label="活动分页">
                <button
                  type="button"
                  className="sr-button"
                  disabled={selectionLocked || !validSelection || props.activities.read.state === 'loading'}
                  onClick={() => {
                    if (!selectionLocked && validSelection && props.activities.read.state !== 'loading')
                      props.onActivitiesPage({ ...FIRST_PAGE });
                  }}
                >
                  从第一页重新读取活动
                </button>
                <button
                  type="button"
                  className="sr-button"
                  disabled={selectionLocked || !activities?.nextAfter}
                  onClick={() => {
                    if (!selectionLocked && activities?.nextAfter)
                      props.onActivitiesPage({
                        after: activities.nextAfter,
                        censusSha256: activities.censusSha256,
                      });
                  }}
                >
                  下一页活动
                </button>
              </nav>
            </div>
          </section>
          <section
            className={`sr-panel${compactEmptyReports ? ' sr-empty-overview' : ''}`}
            data-expanded={emptyReportsExpanded}
            aria-label="已保存月报"
            aria-busy={available && props.reportCards.read.state === 'loading'}
          >
            <h2>已保存月报</h2>
            {compactEmptyReports && (
              <button
                type="button"
                className="sr-button sr-overview-toggle"
                aria-expanded={emptyReportsExpanded}
                aria-controls={`${overviewId}-empty-reports`}
                onClick={() => setEmptyReportsExpanded((expanded) => !expanded)}
              >
                {emptyReportsExpanded ? '收起空月报页详情与分页' : '当前页暂无月报 · 展开详情与分页'}
              </button>
            )}
            <div id={`${overviewId}-empty-reports`} className="sr-overview-body">
              <p className="sr-muted">当前页元数据不代表完整月报库，也不授予原件或快照读取权限。</p>
              {!available ? (
                <p role="status">月报列表当前不可用：请先确认当前访问范围。</p>
              ) : (
                <ReadNotice read={props.reportCards.read} label="月报列表" />
              )}
              {available && props.reportCards.resetNotice && (
                <p role="status" className="sr-warning">
                  {props.reportCards.resetNotice}
                </p>
              )}
              {reportCards && (
                <>
                  {reportCards.items.length === 0 && (
                    <p>当前页没有已保存月报；未载入或不可用不等于零份月报。</p>
                  )}
                  <ul className="sr-card-list">
                    {reportCards.items.map((card) => (
                      <li className="sr-report-card" key={card.id}>
                        <h3>
                          {card.period.month} · {card.period.timeZone}
                        </h3>
                        <p>
                          客户 {card.customer.organizationId} · {card.customer.contactId ?? '机构级汇总'}
                        </p>
                        <p className="sr-muted">
                          {card.id} · 状态修订 {card.revision}
                        </p>
                        <p className="sr-muted">生成于 {card.generatedAt}</p>
                        <p>
                          {card.state.archivedAt === null ? '未归档' : '已归档'}
                          {card.state.supersededByReportId !== null ? ' · 已被替代' : ''}
                        </p>
                        <button
                          type="button"
                          className="sr-button"
                          disabled={selectionLocked}
                          onClick={() => {
                            if (!selectionLocked) props.onChooseReport(card.id);
                          }}
                        >
                          查看月报 {card.period.month}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <nav className="sr-actions sr-pagination" aria-label="月报分页">
                <button
                  type="button"
                  className="sr-button"
                  disabled={selectionLocked || props.reportCards.read.state === 'loading'}
                  onClick={() => {
                    if (!selectionLocked && props.reportCards.read.state !== 'loading')
                      props.onReportsPage({ ...FIRST_PAGE });
                  }}
                >
                  从第一页重新读取月报
                </button>
                <button
                  type="button"
                  className="sr-button"
                  disabled={selectionLocked || !reportCards?.nextAfter}
                  onClick={() => {
                    if (!selectionLocked && reportCards?.nextAfter)
                      props.onReportsPage({
                        after: reportCards.nextAfter,
                        censusSha256: reportCards.censusSha256,
                      });
                  }}
                >
                  下一页月报
                </button>
              </nav>
            </div>
          </section>
        </div>
        {available && <ActivityEditor props={props} disabled={locked} />}
      </div>
      {available && <ReadNotice read={props.selectedReport} label="月报详情" />}
      {report && (
        <ReportSnapshot report={report} props={props} disabled={selectionLocked} canReplace={canReplace} />
      )}
      {props.openingSource && available && (
        <p role="status">正在核验并打开精确来源；可用性以当前读取结果为准。</p>
      )}
    </main>
  );
}
