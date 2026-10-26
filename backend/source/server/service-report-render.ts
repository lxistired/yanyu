import { AdapterError } from "../shared/contracts";
import {
  SERVICE_REPORT_LIMITS as L,
  type ServiceReport,
  type ServiceReportFormat,
} from "../shared/service-reports";
export type ServiceReportDownload = {
  filename: string;
  mediaType:
    | "application/json; charset=utf-8"
    | "text/csv; charset=utf-8"
    | "text/html; charset=utf-8";
  content: Buffer;
  headers: {
    "Cache-Control": "private, no-store";
    "X-Content-Type-Options": "nosniff";
    "Content-Security-Policy": string;
  };
  provenance: "derived-user-recorded-service-summary";
};
const DISCLAIMER =
  "本月报汇总所有者手工记录的活动。记录中的完成、阅读、会议或邮件状态不证明客户实际阅读、出席或收件。来源引用用于追溯，不构成上述行为的自动验证。本报告是派生内容，不能作为新的原始证据。";
const CALENDAR_RULE =
  "活动时间先转换至所选时区，按本地日历年与月归属；历史回拨可使同月对应非连续 UTC 时段，不按单一 UTC 起止区间筛选。";
const kindLabels = {
  "content-read": "阅读（用户记录）",
  meeting: "会议（用户记录）",
  call: "通话（用户记录）",
  email: "邮件（用户记录）",
  "research-support": "研究支持（用户记录）",
  other: "其他（用户记录）",
};
const statusLabels = {
  planned: "计划",
  "reported-completed": "用户记录为已完成",
  cancelled: "取消",
};
const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => htmlEscapes[c]);
/** RFC 4180 quoting plus spreadsheet formula neutralization for every untrusted text field. */
export function serviceReportCsvCell(value: string | number): string {
  const raw = String(value),
    safe =
      typeof value === "string" && /^[\s]*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
/** Internal rendering only. Call domain.exportReport for authorization; this pure function has no authority. */
export function renderServiceReport(
  report: ServiceReport,
  format: ServiceReportFormat,
): ServiceReportDownload {
  if (
    !["json", "csv", "html"].includes(format) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(report.id) ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(report.snapshot.period.month)
  )
    throw new AdapterError("INVALID_REQUEST", "服务月报下载格式或标识无效");
  const s = report.snapshot;
  const envelope = {
    reportId: report.id,
    revision: report.revision,
    snapshotSha256: report.snapshotSha256,
    state: report.state,
    currentActivitiesChanged: report.currentActivitiesChanged,
    authorization: report.authorization,
    disclaimer: DISCLAIMER,
    calendarSelection: CALENDAR_RULE,
    snapshot: s,
  };
  let content: string;
  if (format === "json") content = `${JSON.stringify(envelope, null, 2)}\n`;
  else if (format === "csv") {
    const rows: (string | number)[][] = [
      ["说明", DISCLAIMER],
      ["月报ID", report.id],
      ["月报修订号", report.revision],
      ["快照 SHA-256", report.snapshotSha256],
      ["月份", s.period.month],
      ["时区", s.period.timeZone],
      ["时区数据库版本", s.period.tzdbVersion],
      ["月份归属规则", CALENDAR_RULE],
      [
        "本月首次出现（UTC 参考点，不是区间边界）",
        s.period.utcMarkers.firstInstantOfMonth,
      ],
      [
        "次月首次出现（UTC 参考点，不是区间边界）",
        s.period.utcMarkers.firstInstantOfFollowingMonth,
      ],
      ["统计口径", "所有者记录的活动条数"],
      ["活动记录总数", s.totals.totalRecords],
      [
        "生成后活动已改变",
        report.currentActivitiesChanged ? "是；本快照未修改" : "否",
      ],
      ["已被新版替代", report.state.supersededByReportId ?? "否"],
      [
        "活动ID",
        "活动版本ID",
        "记录修订号",
        "发生时间UTC",
        "活动类型",
        "记录状态",
        "组织ID",
        "联系人ID",
        "所有者摘要",
        "来源引用（完整JSON；不含正文）",
      ],
      ...s.activities.map((a) => [
        a.id,
        a.versionId,
        a.revision,
        a.version.value.occurredAt,
        kindLabels[a.version.value.kind],
        statusLabels[a.version.value.status],
        a.version.value.customer.organizationId,
        a.version.value.customer.contactId ?? "",
        a.version.value.summary,
        JSON.stringify(a.version.value.references),
      ]),
    ];
    content =
      rows.map((row) => row.map(serviceReportCsvCell).join(",")).join("\r\n") +
      "\r\n";
  } else {
    const e = escapeHtml;
    content = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${e(s.period.month)} 服务月报</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 24px;color:#162330}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd5dd;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}small{display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:16px;background:#eef3f6}</style></head><body>
      <h1>${e(s.period.month)} 服务月报</h1><p class="notice">${e(DISCLAIMER)}</p>
      <p>时区：${e(s.period.timeZone)}；时区数据库：${e(s.period.tzdbVersion)}<br>月份归属规则：${e(CALENDAR_RULE)}<br>本月首次出现（UTC 参考点，不是区间边界）：${e(s.period.utcMarkers.firstInstantOfMonth)}<br>次月首次出现（UTC 参考点，不是区间边界）：${e(s.period.utcMarkers.firstInstantOfFollowingMonth)}<br>所有者记录的活动条数：${s.totals.totalRecords}</p>
      <p>生成后活动${report.currentActivitiesChanged ? "已改变；以下保留原快照" : "未改变"}${report.state.supersededByReportId ? `；已由 ${e(report.state.supersededByReportId)} 替代` : ""}</p>
      <table><thead><tr><th>发生时间 UTC</th><th>活动和记录状态</th><th>所有者摘要</th><th>固定来源引用</th></tr></thead><tbody>${s.activities.map((a) => `<tr><td>${e(a.version.value.occurredAt)}<small>活动 ${e(a.id)}<br>版本 ${e(a.versionId)}</small></td><td>${e(kindLabels[a.version.value.kind])}<br>${e(statusLabels[a.version.value.status])}<small>组织 ${e(a.version.value.customer.organizationId)}<br>联系人 ${e(a.version.value.customer.contactId ?? "未指定")}</small></td><td>${e(a.version.value.summary)}</td><td><pre>${e(JSON.stringify(a.version.value.references, null, 2))}</pre></td></tr>`).join("")}</tbody></table>
      <p>生成时间：${e(s.generatedAt)}<br>月报 ID：${e(report.id)}<br>月报修订号：${report.revision}<br>快照 SHA-256：${e(report.snapshotSha256)}</p></body></html>`;
  }
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length > L.exportBytes)
    throw new AdapterError("RATE_LIMITED", "完整月报下载超过字节限制；未截断");
  return {
    filename: `service-report-${s.period.month}-${report.id}.${format}`,
    mediaType:
      format === "json"
        ? "application/json; charset=utf-8"
        : format === "csv"
          ? "text/csv; charset=utf-8"
          : "text/html; charset=utf-8",
    content: buffer,
    provenance: "derived-user-recorded-service-summary",
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox",
    },
  };
}
