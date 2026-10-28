// Billing periods are calendar months in the billing time zone. Usage timestamps carry their own offset.

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

/** ISO 8601 date and time with an explicit offset; "Z" or "-04:00" both work. A time with no zone is ambiguous, so it is refused. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-](0\d|1[0-4]):[0-5]\d)$/;

function parseTimestamp(timestamp: string): Date {
  const m = TIMESTAMP.exec(timestamp.trim());
  const d = new Date(timestamp.trim());
  // JavaScript rolls Feb 30 over to Mar 2; check the calendar date exists instead.
  const realDate = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= daysInPeriod(`${m[1]}-${m[2]}`);
  if (!realDate || Number.isNaN(d.getTime())) {
    throw new Error(`timestamp "${timestamp}" must be an ISO 8601 date and time with a time zone, e.g. 2026-10-15T12:00:00Z`);
  }
  return d;
}

/** "2026-11-01T03:30:00Z" -> { billing: "2026-10", utc: "2026-11", local: "2026-10-31 23:30" } */
export function periodsFor(timestamp: string) {
  const d = parseTimestamp(timestamp);
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
