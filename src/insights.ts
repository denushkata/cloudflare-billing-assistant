// Portfolio insights, computed in code from the customers' ledgers. Like the reconciliation
// itself, every number here is deterministic; the model may only describe them.
//
// Amounts are the issue-level differences shown on each card (pre-tax, except a duplicate
// line, which carries its own tax). "Undercharged" is revenue leakage; "overcharged" is
// refund exposure and customer-trust risk.

import { ISSUE_NAMES } from "./ai";
import type { Issue, IssueStatus } from "./ledger";
import { formatCents } from "./recon/money";
import type { FindingType } from "./recon/reconcile";

export type InsightIssue = Issue & { customerId: string };
type ReviewStatus = Exclude<IssueStatus, "explained">;
type ByStatus = Record<ReviewStatus, number>;

export interface Insights {
  period: string;
  issues: number;
  exposure: { underchargedCents: ByStatus & { total: number }; overchargedCents: ByStatus & { total: number } };
  rootCauses: { type: FindingType; label: string; count: number; underchargedCents: number; overchargedCents: number; totalCents: number }[];
  aging: { buckets: { label: string; count: number }[]; oldest: { key: string; customerId: string; ageDays: number; status: ReviewStatus } | null };
  medianHoursToResolve: number | null;
  recurrence: { repeats: number; of: number; percent: number; keys: string[]; issues: { key: string; customerId: string; label: string }[] };
  hotspots: { customerId: string; openCents: number; issues: number; open: number; repeats: number }[];
  /** One deterministic sentence, shown when the AI summary is unavailable. */
  summary: string;
}

const DAY_MS = 86_400_000;
export const AGING_BUCKETS = [
  { label: "0–2 days", max: 2 },
  { label: "3–7 days", max: 7 },
  { label: "8+ days", max: Infinity },
];
export const MAX_HOTSPOTS = 8;

/**
 * `issues` are every issue in the selected customers' ledgers, all periods.
 * Exposure, root causes, recurrence and hotspots cover `period`; aging covers every
 * issue still open or escalated, whatever its period.
 */
export function computeInsights(issues: InsightIssue[], period: string, now: string): Insights {
  const errors = issues.filter((i) => i.severity === "error");
  const current = errors.filter((i) => i.period === period);
  const nowMs = Date.parse(now);

  const exposure = {
    underchargedCents: { open: 0, escalated: 0, resolved: 0, total: 0 },
    overchargedCents: { open: 0, escalated: 0, resolved: 0, total: 0 },
  };
  for (const i of current) {
    const side = i.differenceCents < 0 ? exposure.underchargedCents : exposure.overchargedCents;
    const amount = Math.abs(i.differenceCents);
    side[i.status as ReviewStatus] += amount;
    side.total += amount;
  }

  const byType = new Map<FindingType, Insights["rootCauses"][number]>();
  for (const i of current) {
    const row = byType.get(i.type) ?? { type: i.type, label: ISSUE_NAMES[i.type], count: 0, underchargedCents: 0, overchargedCents: 0, totalCents: 0 };
    row.count++;
    if (i.differenceCents < 0) row.underchargedCents += -i.differenceCents;
    else row.overchargedCents += i.differenceCents;
    row.totalCents += Math.abs(i.differenceCents);
    byType.set(i.type, row);
  }
  const rootCauses = [...byType.values()].sort((a, b) => b.totalCents - a.totalCents || b.count - a.count || a.type.localeCompare(b.type));

  const pending = errors.filter((i) => i.status === "open" || i.status === "escalated");
  const ageDays = (i: InsightIssue) => Math.max(0, Math.floor((nowMs - Date.parse(i.firstSeenAt)) / DAY_MS));
  const buckets = AGING_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const i of pending) buckets[AGING_BUCKETS.findIndex((b) => ageDays(i) <= b.max)]!.count++;
  const oldestIssue = [...pending].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.key.localeCompare(b.key))[0];

  const resolveHours = current
    .filter((i) => i.status === "resolved" && i.decidedAt)
    .map((i) => (Date.parse(i.decidedAt!) - Date.parse(i.firstSeenAt)) / 3_600_000)
    .sort((a, b) => a - b);

  // Same rule as the "Seen before" precedent: an earlier-period issue of the same type,
  // for the same customer, that an analyst already decided.
  const repeats = current.filter((i) =>
      errors.some(
      (p) => p.customerId === i.customerId && p.type === i.type && p.period < i.period && (p.status === "resolved" || p.status === "escalated"),
    ),
  );
  const repeatKeys = repeats.map((i) => i.key);

  const byCustomer = new Map<string, Insights["hotspots"][number]>();
  for (const i of current) {
    const row = byCustomer.get(i.customerId) ?? { customerId: i.customerId, openCents: 0, issues: 0, open: 0, repeats: 0 };
    row.issues++;
    if (i.status !== "resolved") {
      row.open++;
      row.openCents += Math.abs(i.differenceCents);
    }
    if (repeatKeys.includes(i.key)) row.repeats++;
    byCustomer.set(i.customerId, row);
  }
  const hotspots = [...byCustomer.values()]
    .filter((c) => c.open > 0)
    .sort((a, b) => b.openCents - a.openCents || b.issues - a.issues || a.customerId.localeCompare(b.customerId))
    .slice(0, MAX_HOTSPOTS);

  const insights: Insights = {
    period,
    issues: current.length,
    exposure,
    rootCauses,
    aging: {
      buckets,
      oldest: oldestIssue
        ? { key: oldestIssue.key, customerId: oldestIssue.customerId, ageDays: ageDays(oldestIssue), status: oldestIssue.status as ReviewStatus }
        : null,
    },
    medianHoursToResolve: resolveHours.length ? round1(median(resolveHours)) : null,
    recurrence: {
      repeats: repeatKeys.length,
      of: current.length,
      percent: current.length ? Math.round((repeatKeys.length / current.length) * 100) : 0,
      keys: repeatKeys,
      issues: repeats.map((i) => ({ key: i.key, customerId: i.customerId, label: ISSUE_NAMES[i.type] })),
    },
    hotspots,
    summary: "",
  };
  insights.summary = summarize(insights);
  return insights;
}

/** What the model sees: every number pre-formatted, so there is nothing left to compute. */
export function insightFacts(x: Insights): Record<string, unknown> {
  const side = (s: Insights["exposure"]["overchargedCents"]) =>
    `${money(s.total)} total: ${money(s.open)} open, ${money(s.escalated)} escalated, ${money(s.resolved)} resolved`;
  return {
    period: x.period,
    issues_this_period: x.issues,
    overcharged_customers_refund_exposure: side(x.exposure.overchargedCents),
    undercharged_customers_revenue_leakage: side(x.exposure.underchargedCents),
    root_causes_largest_first: x.rootCauses.map((r) => `${r.label}: ${r.count} issue${r.count === 1 ? "" : "s"}, ${money(r.totalCents)}`),
    repeats_of_earlier_decided_issues: `${x.recurrence.repeats} of ${x.recurrence.of} (${x.recurrence.percent}%)`,
    customers_with_most_open_exposure: x.hotspots.map(
      (h) => `${h.customerId}: ${money(h.openCents)} open${h.repeats ? ", repeat issue" : ""}`,
    ),
    repeat_issues: x.recurrence.issues.map((r) => `${r.customerId}: ${r.label}`),
    open_or_escalated_by_age: x.aging.buckets.map((b) => `${b.label}: ${b.count}`),
  };
}

function summarize(x: Insights): string {
  if (!x.issues) return `No billing errors found for ${x.period}.`;
  const top = x.rootCauses[0]!;
  const parts = [
    `${x.issues} issue${x.issues === 1 ? "" : "s"} in ${x.period}: ${money(x.exposure.overchargedCents.total)} overcharged and ${money(x.exposure.underchargedCents.total)} undercharged.`,
    `Largest: ${top.label} (${money(top.totalCents)}).`,
  ];
  if (x.recurrence.repeats) parts.push(`${x.recurrence.repeats} of ${x.issues} ${x.recurrence.repeats === 1 ? "is a repeat" : "are repeats"} of an earlier decided issue.`);
  return parts.join(" ");
}

const median = (xs: number[]) => (xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2);
const round1 = (n: number) => Math.round(n * 10) / 10;
const money = formatCents;
