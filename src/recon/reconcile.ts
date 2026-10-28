// Deterministic reconciliation. Every amount here is computed in integer cents;
// the LLM later receives these findings as facts and only explains them.
//
// Each check isolates one invoice component and measures it against the invoice's
// own other lines, so a single root cause produces a single finding instead of a
// cascade (a missing discount does not also show up as a tax error).

import { formatCents, lineAmount, roundDiv, taxOn } from "./money";
import type { CreditMemo, InvoiceLine, Plan, ReconcileInput } from "./model";
import { BILLING_TIME_ZONE, daysInPeriod, daysOf } from "./period";
import { STATE_TAX_BP } from "./tax";

export type FindingType =
  | "missing_plan"
  | "duplicate_line"
  | "proration_error"
  | "base_mismatch"
  | "overage_on_total"
  | "timezone_boundary"
  | "overage_mismatch"
  | "discount_missing"
  | "discount_mismatch"
  | "tax_wrong_state"
  | "tax_mismatch"
  | "unsupported_credit"
  | "credit_applied";

/** "error" needs an analyst decision; "explained" looks off but is correct and only needs an explanation. */
export type Severity = "error" | "explained";

export interface Finding {
  id: string;
  customerId: string;
  invoiceId: string;
  period: string;
  type: FindingType;
  severity: Severity;
  /** What this component should contribute to the invoice, in cents. Credits are negative. */
  expectedCents: number;
  invoicedCents: number;
  /** invoiced - expected. Positive means the customer was overcharged. */
  differenceCents: number;
  /** One deterministic sentence. Shown as-is when the AI explanation is unavailable. */
  summary: string;
  /** Display-ready facts for the AI prompt. Money is pre-formatted so the model never converts or computes. */
  facts: Record<string, string | number | string[]>;
}

export interface InvoiceResult {
  invoiceId: string;
  customerId: string;
  period: string;
  status: "clean" | "explained" | "flagged";
  expectedTotalCents: number;
  invoicedTotalCents: number;
  differenceCents: number;
  findings: Finding[];
}

export interface ReconcileResult {
  invoices: InvoiceResult[];
  findings: Finding[];
  counts: { invoices: number; clean: number; explained: number; flagged: number };
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const invoiceIds = [...new Set(input.invoices.map((l) => l.invoiceId))];
  const invoices = invoiceIds.map((id) =>
    reconcileInvoice(
      input.invoices.filter((l) => l.invoiceId === id),
      input,
    ),
  );
  return {
    invoices,
    findings: invoices.flatMap((i) => i.findings),
    counts: {
      invoices: invoices.length,
      clean: invoices.filter((i) => i.status === "clean").length,
      explained: invoices.filter((i) => i.status === "explained").length,
      flagged: invoices.filter((i) => i.status === "flagged").length,
    },
  };
}

interface Segment {
  plan: Plan;
  from: string;
  to: string;
  days: number;
}

function reconcileInvoice(lines: InvoiceLine[], input: ReconcileInput): InvoiceResult {
  const first = lines[0]!;
  const { invoiceId, customerId, period } = first;
  for (const l of lines) {
    if (l.customerId !== customerId || l.period !== period) {
      throw new Error(`${l.source}: invoice ${invoiceId} mixes customers or periods`);
    }
  }

  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "id" | "customerId" | "invoiceId" | "period" | "differenceCents">) =>
    findings.push({
      id: `${invoiceId}:${f.type}${findings.some((x) => x.type === f.type) ? `:${findings.length}` : ""}`,
      customerId,
      invoiceId,
      period,
      differenceCents: f.invoicedCents - f.expectedCents,
      ...f,
    });

  const invoicedTotalCents = sum(lines, (l) => l.amountCents + l.taxCents - l.creditsCents);
  const segments = planSegments(input.plans.filter((p) => p.customerId === customerId), period);

  if (segments.length === 0 || segments[0]!.from !== `${period}-01`) {
    add({
      type: "missing_plan",
      severity: "error",
      expectedCents: 0,
      invoicedCents: invoicedTotalCents,
      summary: `No plan terms cover the start of ${period} for ${customerId}, so the invoice cannot be checked.`,
      facts: { period },
    });
    return result(invoiceId, customerId, period, findings, 0, invoicedTotalCents);
  }

  const plan = segments[segments.length - 1]!.plan; // usage, discount and tax follow the plan in effect at period end
  const taxBp = STATE_TAX_BP[plan.taxState]!;

  // 1. Duplicate lines. Later checks run on the de-duplicated lines.
  const unique: InvoiceLine[] = [];
  const dupes: InvoiceLine[] = [];
  for (const l of lines) {
    const key = (x: InvoiceLine) =>
      [x.lineItem, x.quantity, x.amountCents, x.taxCents, x.creditsCents, x.creditMemoId].join("|");
    (unique.some((u) => key(u) === key(l)) ? dupes : unique).push(l);
  }
  if (dupes.length) {
    const extra = sum(dupes, (l) => l.amountCents + l.taxCents - l.creditsCents);
    add({
      type: "duplicate_line",
      severity: "error",
      expectedCents: 0,
      invoicedCents: extra,
      summary: `The ${dupes.map((d) => d.lineItem).join(", ")} line appears twice; the copy adds ${formatCents(extra)} including tax.`,
      facts: {
        duplicated_line: dupes.map((d) => `${d.lineItem}: quantity ${d.quantity}, amount ${formatCents(d.amountCents)}, tax ${formatCents(d.taxCents)}`),
        extra_charge_including_tax: formatCents(extra),
      },
    });
  }
  const of = (item: InvoiceLine["lineItem"]) => unique.filter((l) => l.lineItem === item);

  // 2. Base fee, prorated by day across plan changes.
  const days = daysInPeriod(period);
  const expectedBase = roundDiv(sum(segments, (s) => s.plan.priceCents * s.days), days);
  const invoicedBase = sum(of("base"), (l) => l.amountCents);
  if (invoicedBase !== expectedBase) {
    const fullMonthOf = segments.find((s) => s.plan.priceCents === invoicedBase);
    const isProration = segments.length > 1 && fullMonthOf !== undefined;
    add({
      type: isProration ? "proration_error" : "base_mismatch",
      severity: "error",
      expectedCents: expectedBase,
      invoicedCents: invoicedBase,
      summary: isProration
        ? `The plan changed mid-period but the base fee was billed at the ${fullMonthOf.plan.plan} price of ${formatCents(invoicedBase)} for the full month; the prorated base fee is ${formatCents(expectedBase)}.`
        : `The base fee is ${formatCents(invoicedBase)}; plan terms give ${formatCents(expectedBase)}.`,
      facts: {
        plan_segments: segments.map(
          (s) => `${s.plan.plan} at ${formatCents(s.plan.priceCents)}/month from ${s.from} to ${s.to} (${s.days} of ${days} days)`,
        ),
        ...(isProration ? { billed_as_full_month_of: fullMonthOf.plan.plan } : {}),
      },
    });
  }

  // 3. Usage overage. Usage belongs to the month it fell in, in the billing time zone.
  const usage = input.usage.filter((u) => u.customerId === customerId);
  const billingQty = sum(usage.filter((u) => u.billingPeriod === period), (u) => u.quantity);
  const utcQty = sum(usage.filter((u) => u.utcPeriod === period), (u) => u.quantity);
  const overageQty = (qty: number) => Math.max(0, qty - plan.includedQuantity);
  const expectedOverQty = overageQty(billingQty);
  const expectedOver = lineAmount(expectedOverQty, plan.overageRateMicros);
  const invoicedOverQty = sum(of("overage"), (l) => l.quantity);
  const invoicedOver = sum(of("overage"), (l) => l.amountCents);
  if (invoicedOver !== expectedOver || invoicedOverQty !== expectedOverQty) {
    const onTotal = invoicedOverQty === billingQty && billingQty !== expectedOverQty;
    const boundary = !onTotal && utcQty !== billingQty && invoicedOverQty === overageQty(utcQty);
    const boundaryRecords = usage.filter((u) => u.billingPeriod !== u.utcPeriod && (u.billingPeriod === period || u.utcPeriod === period));
    const type = onTotal ? "overage_on_total" : boundary ? "timezone_boundary" : "overage_mismatch";
    add({
      type,
      severity: "error",
      expectedCents: expectedOver,
      invoicedCents: invoicedOver,
      summary:
        type === "overage_on_total"
          ? `Overage was charged on all ${units(billingQty)} units instead of the ${units(expectedOverQty)} units above the ${units(plan.includedQuantity)} included.`
          : type === "timezone_boundary"
            ? `Usage was assigned to months by the UTC calendar instead of the billing time zone (${BILLING_TIME_ZONE}); ${boundaryRecords.length === 1 ? "1 usage record" : `${boundaryRecords.length} usage records`} near midnight landed in the wrong period.`
            : `Overage is ${units(invoicedOverQty)} units for ${formatCents(invoicedOver)}; usage gives ${units(expectedOverQty)} units for ${formatCents(expectedOver)}.`,
      facts: {
        usage_in_period: billingQty,
        included_quantity: plan.includedQuantity,
        overage_rate_per_unit: formatRate(plan.overageRateMicros),
        expected_overage_units: expectedOverQty,
        invoiced_overage_units: invoicedOverQty,
        ...(type === "timezone_boundary"
          ? {
              usage_in_period_by_utc_calendar: utcQty,
              boundary_records: boundaryRecords.map(
                (u) => `${u.quantity} units at ${u.timestamp} UTC = ${u.localTime} billing time, belongs to ${u.billingPeriod}`,
              ),
            }
          : {}),
      },
    });
  }

  // 4. Contract discount, measured against the invoice's own subtotal.
  const invoicedSubtotal = invoicedBase + invoicedOver;
  const expectedDiscount = 0 - roundDiv(invoicedSubtotal * plan.discountBp, 10_000);
  const invoicedDiscount = sum(of("discount"), (l) => l.amountCents);
  if (invoicedDiscount !== expectedDiscount) {
    const missing = plan.discountBp > 0 && of("discount").length === 0;
    add({
      type: missing ? "discount_missing" : "discount_mismatch",
      severity: "error",
      expectedCents: expectedDiscount,
      invoicedCents: invoicedDiscount,
      summary: missing
        ? `The contract's ${formatPct(plan.discountBp)} discount (${formatCents(expectedDiscount)}) is not on the invoice.`
        : `The discount is ${formatCents(invoicedDiscount)}; ${formatPct(plan.discountBp)} of the subtotal is ${formatCents(expectedDiscount)}.`,
      facts: {
        contract_discount: formatPct(plan.discountBp),
        subtotal_before_discount: formatCents(invoicedSubtotal),
      },
    });
  }

  // 5. Tax, recomputed on the invoice's own lines at the plan's state rate.
  const taxAt = (bp: number) => sum(unique, (l) => taxOn(l.amountCents, bp));
  const expectedTax = taxAt(taxBp);
  const invoicedTax = sum(unique, (l) => l.taxCents);
  if (invoicedTax !== expectedTax) {
    const chargedStates = Object.entries(STATE_TAX_BP)
      .filter(([state, bp]) => state !== plan.taxState && taxAt(bp) === invoicedTax)
      .map(([state]) => state);
    const wrongState = chargedStates.length > 0;
    add({
      type: wrongState ? "tax_wrong_state" : "tax_mismatch",
      severity: "error",
      expectedCents: expectedTax,
      invoicedCents: invoicedTax,
      summary: wrongState
        ? `Tax was charged at the ${chargedStates.join("/")} rate instead of the ${plan.taxState} rate of ${formatPct(taxBp)}.`
        : `Tax is ${formatCents(invoicedTax)}; ${plan.taxState} tax at ${formatPct(taxBp)} on these lines is ${formatCents(expectedTax)}.`,
      facts: {
        customer_tax_state: plan.taxState,
        correct_rate: formatPct(taxBp),
        ...(wrongState
          ? { rate_actually_charged: chargedStates.map((s) => `${s} ${formatPct(STATE_TAX_BP[s]!)}`) }
          : {}),
      },
    });
  }

  // 6. Credits. A credit is legitimate only if it references an approved memo for this customer, period and amount.
  let approvedCredits = 0;
  for (const l of unique.filter((x) => x.creditsCents !== 0 || x.creditMemoId)) {
    const memo = input.creditMemos.find((m) => m.creditMemoId === l.creditMemoId);
    const problem = creditProblem(l, memo);
    const memoAmount = problem === undefined || problem.countsMemo ? memo!.amountCents : 0;
    approvedCredits += memoAmount;
    add({
      type: problem ? "unsupported_credit" : "credit_applied",
      severity: problem ? "error" : "explained",
      expectedCents: 0 - memoAmount,
      invoicedCents: 0 - l.creditsCents,
      summary: problem
        ? `A ${formatCents(l.creditsCents)} credit ${problem.text}.`
        : `The invoice is ${formatCents(l.creditsCents)} lower because approved credit memo ${memo!.creditMemoId} was applied: ${memo!.reason}.`,
      facts: {
        credit_on_invoice: formatCents(l.creditsCents),
        credit_memo_id: l.creditMemoId || "(none)",
        ...(memo
          ? {
              memo_customer: memo.customerId,
              memo_period: memo.period,
              memo_amount: formatCents(memo.amountCents),
              memo_reason: memo.reason,
              memo_approved_by: memo.approvedBy,
            }
          : {}),
      },
    });
  }

  const expectedLines = [expectedBase, expectedOver, 0 - roundDiv((expectedBase + expectedOver) * plan.discountBp, 10_000)];
  const expectedTotalCents = sum(expectedLines, (a) => a + taxOn(a, taxBp)) - approvedCredits;
  return result(invoiceId, customerId, period, findings, expectedTotalCents, invoicedTotalCents);
}

function creditProblem(line: InvoiceLine, memo: CreditMemo | undefined): { text: string; countsMemo: boolean } | undefined {
  if (!line.creditMemoId) return { text: "has no credit memo reference", countsMemo: false };
  if (!memo) return { text: `references credit memo ${line.creditMemoId}, which does not exist`, countsMemo: false };
  if (memo.customerId !== line.customerId) return { text: `references credit memo ${memo.creditMemoId}, which belongs to ${memo.customerId}`, countsMemo: false };
  if (memo.period !== line.period) return { text: `references credit memo ${memo.creditMemoId}, which was approved for ${memo.period}`, countsMemo: false };
  if (memo.amountCents !== line.creditsCents) return { text: `does not match credit memo ${memo.creditMemoId}, which approved ${formatCents(memo.amountCents)}`, countsMemo: true };
  return undefined;
}

/** Split the period into runs of days covered by the same plan (latest effective_date on or before each day). */
function planSegments(plans: Plan[], period: string): Segment[] {
  const sorted = [...plans].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const segments: Segment[] = [];
  for (const day of daysOf(period)) {
    const plan = sorted.filter((p) => p.effectiveDate <= day).pop();
    if (!plan) continue;
    const last = segments[segments.length - 1];
    if (last && last.plan === plan) {
      last.to = day;
      last.days++;
    } else segments.push({ plan, from: day, to: day, days: 1 });
  }
  return segments;
}

function result(
  invoiceId: string,
  customerId: string,
  period: string,
  findings: Finding[],
  expectedTotalCents: number,
  invoicedTotalCents: number,
): InvoiceResult {
  const status = findings.some((f) => f.severity === "error") ? "flagged" : findings.length ? "explained" : "clean";
  return {
    invoiceId,
    customerId,
    period,
    status,
    expectedTotalCents,
    invoicedTotalCents,
    differenceCents: invoicedTotalCents - expectedTotalCents,
    findings,
  };
}

const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((acc, x) => acc + f(x), 0);
const units = (n: number) => n.toLocaleString("en-US");
const formatPct = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const formatRate = (micros: number) => `$${(micros / 1e6).toFixed(6).replace(/0{1,4}$/, "")}`;
