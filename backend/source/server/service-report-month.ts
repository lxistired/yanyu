import { AdapterError } from "../shared/contracts";
import type { ServiceMonth } from "../shared/service-reports";
const invalid = (): never => {
  throw new AdapterError(
    "INVALID_REQUEST",
    "需要有效的 YYYY-MM、IANA 时区及带毫秒的 UTC 时间",
  );
};
export function serviceInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
function formatter(timeZone: string) {
  if (
    typeof timeZone !== "string" ||
    timeZone.length > 100 ||
    !(timeZone === "UTC" || /^[A-Za-z_+-]+\/[A-Za-z0-9_+/-]+$/.test(timeZone))
  )
    return invalid();
  try {
    return new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return invalid();
  }
}
function parts(format: Intl.DateTimeFormat, instant: number) {
  const result: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(instant)))
    if (part.type !== "literal") result[part.type] = Number(part.value);
  return result;
}
function localStamp(format: Intl.DateTimeFormat, instant: number) {
  const p = parts(format, instant);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
function boundary(
  format: Intl.DateTimeFormat,
  year: number,
  month: number,
): string {
  const target = Date.UTC(year, month - 1, 1),
    offsets = new Set<number>();
  for (let h = -72; h <= 72; h += 6) {
    const t = target + h * 3_600_000;
    offsets.add(localStamp(format, t) - t);
  }
  const exact = [...offsets]
    .map((offset) => target - offset)
    .filter((t) => localStamp(format, t) === target);
  if (exact.length) return new Date(Math.min(...exact)).toISOString();
  // Midnight may be skipped by a real civil-time transition. Choose the transition's first valid instant.
  for (let h = -48; h < 48; h++) {
    let lo = target + h * 3_600_000,
      hi = lo + 3_600_000;
    if (localStamp(format, lo) >= target || localStamp(format, hi) < target)
      continue;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (localStamp(format, mid) >= target) hi = mid;
      else lo = mid;
    }
    return new Date(hi).toISOString();
  }
  return invalid();
}
export function serviceMonth(month: unknown, timeZone: unknown): ServiceMonth {
  if (
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    typeof timeZone !== "string"
  )
    return invalid();
  const year = Number(month.slice(0, 4)),
    m = Number(month.slice(5));
  if (year < 1970 || year > 9998) return invalid();
  const format = formatter(timeZone);
  return {
    month,
    timeZone: format.resolvedOptions().timeZone,
    membership: "local-calendar-year-month",
    utcMarkers: {
      firstInstantOfMonth: boundary(format, year, m),
      firstInstantOfFollowingMonth: boundary(
        format,
        m === 12 ? year + 1 : year,
        m === 12 ? 1 : m + 1,
      ),
    },
    tzdbVersion: process.versions.tz ?? "runtime-unspecified",
  };
}
/** Local calendar membership is authoritative, including unusual date-line/midnight transitions. */
export function serviceMonthContains(
  period: ServiceMonth,
  instant: string,
): boolean {
  serviceInstant(instant);
  const p = parts(formatter(period.timeZone), Date.parse(instant));
  return (
    `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}` ===
    period.month
  );
}
