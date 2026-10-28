// Billing periods are calendar months in the billing time zone. Usage timestamps arrive in UTC.

export const BILLING_TIME_ZONE = "America/New_York";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BILLING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parseUtc(timestamp: string): Date {
  const d = new Date(timestamp);
  if (!/(Z|[+-]00:?00)$/.test(timestamp.trim()) || Number.isNaN(d.getTime())) {
    throw new Error(`timestamp "${timestamp}" must be ISO 8601 UTC, e.g. 2026-10-15T12:00:00Z`);
  }
  return d;
}

/** "2026-11-01T03:30:00Z" -> { billing: "2026-10", utc: "2026-11", local: "2026-10-31 23:30" } */
export function periodsFor(timestamp: string) {
  const d = parseUtc(timestamp);
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    billing: `${p.year}-${p.month}`,
    utc: d.toISOString().slice(0, 7),
    local: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
  };
}

export function assertPeriod(period: string, field: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`${field}: "${period}" must look like 2026-10`);
}

export function daysInPeriod(period: string): number {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** ISO date ("2026-10-16") for each day of the period. */
export function daysOf(period: string): string[] {
  return Array.from({ length: daysInPeriod(period) }, (_, i) => `${period}-${String(i + 1).padStart(2, "0")}`);
}
