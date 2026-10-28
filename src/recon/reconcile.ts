// Deterministic reconciliation. Every amount here is computed in integer cents;
// the LLM later receives these findings as facts and only explains them.
//
// Each check isolates one invoice component and measures it against the invoice's
// own other lines, so a single root cause produces a single finding instead of a
// cascade (a missing discount does not also show up as a tax error).
//
// A customer's invoices for one period are checked together, so a charge billed on two
// invoices or a credit memo used twice is caught; each finding is filed on the invoice
// that holds the line in question.

import { formatCents, lineAmount, roundDiv, taxOn } from "./money";
import type { CreditMemo, InvoiceLine, Plan, ReconcileInput, RejectedRow, UsageRecord } from "./model";
import { BILLING_TIME_ZONE, daysInPeriod, daysOf } from "./period";
import { STATE_TAX_BP } from "./tax";

export type FindingType =
  | "missing_plan"
  | "unbilled"
  | "duplicate_line"
  | "proration_error"
  | "base_mismatch"
  | "overage_on_total"
  | "timezone_boundary"
  | "overage_mismatch"
  | "discount_missing"
  | "discount_mismatch"
  | "unrecognized_line"
  | "tax_wrong_state"
  | "tax_mismatch"
  | "unsupported_credit"
  | "credit_not_applied"
  | "credit_exceeds_charges"
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
  /** Text copied from the uploaded files (line items, memo reasons). Shown as data; never trusted as a source of amounts. */
  quoted?: Record<string, string | string[]>;
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
  rejected: RejectedRow[];
  notices: string[];
}

interface Context {
  plans: Map<string, Plan[]>;
  usage: Map<string, UsageRecord[]>;
  memos: Map<string, CreditMemo>;
  rejectedMemos: Map<string, RejectedRow>;
  /** credit memo ID -> invoice it was first applied to */
  memoUses: Map<string, string>;
  notices: Set<string>;
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const ctx: Context = {
    plans: groupBy(input.plans, (p) => p.customerId),
    usage: groupBy(input.usage, (u) => u.customerId),
    memos: new Map(input.creditMemos.map((m) => [m.creditMemoId, m])),
    rejectedMemos: new Map(input.rejected.filter((r) => r.creditMemoId).map((r) => [r.creditMemoId!, r])),
    memoUses: new Map(),
    notices: new Set(input.notices),
  };

  // Partial data gives wrong answers, so a customer with an unreadable plan, usage or invoice row
  // is not checked at all. A bad credit memo row only affects invoices that cite that memo.
  const notChecked = groupBy(
    input.rejected.filter((r) => r.customerId && !r.line.startsWith("credit_memos.csv")),
    (r) => r.customerId!,
  );

  const groups = groupBy(
    input.invoices.filter((l) => !notChecked.has(l.customerId)),
    (l) => `${l.customerId}|${l.period}`,
  );
  const invoices = [...groups.values()].flatMap((lines) => reconcileGroup(lines, ctx));

  // Plan terms with no invoice: the customer was not billed.
  const periods = [...new Set(input.invoices.map((l) => l.period))].sort();
  for (const [customerId, plans] of ctx.plans) {
    if (notChecked.has(customerId)) continue;
    for (const period of periods) {
      const segments = planSegments(plans, period);
      if (!segments.length || groups.has(`${customerId}|${period}`)) continue;
      invoices.push(unbilled(customerId, period, segments, ctx));
    }
  }

  // Approved credit memos that no invoice line cites: the customer is still owed the credit.
  const cited = new Set(input.invoices.map((l) => l.creditMemoId).filter(Boolean));
  for (const memo of input.creditMemos) {
    if (cited.has(memo.creditMemoId) || !memo.approvedBy || !periods.includes(memo.period) || notChecked.has(memo.customerId)) continue;
    const inv = invoices.find((i) => i.customerId === memo.customerId && i.period === memo.period);
    if (!inv) {
      ctx.notices.add(`Approved credit memo ${memo.creditMemoId} (${formatCents(memo.amountCents)}) for ${memo.customerId} has no invoice to apply to.`);
      continue;
    }
    inv.findings.push(
      finding(inv, "credit_not_applied", {
        severity: "error",
        expectedCents: -memo.amountCents,
        invoicedCents: 0,
        summary: `Credit memo ${memo.creditMemoId} approved ${formatCents(memo.amountCents)} for ${memo.period}, but no invoice applies it.`,
        facts: { credit_memo_id: memo.creditMemoId, memo_amount: formatCents(memo.amountCents), memo_period: memo.period, memo_approved_by: memo.approvedBy },
        quoted: { memo_reason: memo.reason },
      }),
    );
    Object.assign(inv, totals(inv.findings, inv.expectedTotalCents - memo.amountCents, inv.invoicedTotalCents));
  }

  for (const [customerId, rows] of notChecked) {
    ctx.notices.add(`${customerId} was not checked: ${rows.length === 1 ? "1 of its rows" : `${rows.length} of its rows`} could not be read (${rows.slice(0, 3).map((r) => r.line).join("; ")}${rows.length > 3 ? "; …" : ""}).`);
  }
  const invoiced = new Set(input.invoices.map((l) => l.customerId));
  for (const customerId of ctx.usage.keys()) {
    if (!ctx.plans.has(customerId) && !invoiced.has(customerId) && !notChecked.has(customerId)) {
      ctx.notices.add(`Usage for ${customerId} matches no plan or invoice, so it was not checked.`);
    }
  }

  const findings = invoices.flatMap((i) => i.findings);
  return {
    invoices,
    findings,
    counts: {
      invoices: invoices.length,
      clean: invoices.filter((i) => i.status === "clean").length,
      explained: invoices.filter((i) => i.status === "explained").length,
      flagged: invoices.filter((i) => i.status === "flagged").length,
    },
    rejected: input.rejected,
    notices: [...ctx.notices],
  };
}

interface Segment {
  plan: Plan;
  from: string;
  to: string;
  days: number;
}

type NewFinding = Omit<Finding, "id" | "customerId" | "invoiceId" | "period" | "differenceCents" | "type">;

/** What plan terms and usage say this customer owes for the period. */
function terms(customerId: string, period: string, segments: Segment[], ctx: Context) {
  const plan = segments[segments.length - 1]!.plan; // usage, discount and tax follow the plan in effect at period end
  const taxBp = STATE_TAX_BP[plan.taxState]!;
  const days = daysInPeriod(period);
  const base = roundDiv(sum(segments, (s) => s.plan.priceCents * s.days), days);

  // Usage belongs to the month it fell in, in the billing time zone. Adjustments (negative quantities) net out.
  const all = ctx.usage.get(customerId) ?? [];
  const usage = all.filter((u) => u.product === plan.product);
  for (const [product, records] of groupBy(all.filter((u) => u.product !== plan.product && u.billingPeriod === period), (u) => u.product)) {
    ctx.notices.add(`${customerId}: ${units(sum(records, (u) => u.quantity))} ${product} in ${period} ${records.length === 1 ? "has" : "have"} no price in the plan terms (the plan meters ${plan.product}), so ${records.length === 1 ? "it was" : "they were"} not checked.`);
  }
  const adjustments = usage.filter((u) => u.billingPeriod === period && u.quantity < 0);
  if (adjustments.length) {
    ctx.notices.add(`${customerId}: ${units(sum(adjustments, (u) => u.quantity))} ${plan.product} of usage adjustments in ${period} were netted against that month's usage.`);
  }
  const billingQty = sum(usage.filter((u) => u.billingPeriod === period), (u) => u.quantity);
  const utcQty = sum(usage.filter((u) => u.utcPeriod === period), (u) => u.quantity);
  if (!Number.isSafeInteger(billingQty) || !Number.isSafeInteger(utcQty)) throw new Error(`usage for ${customerId} is too large to count exactly`);
  const overageQty = (qty: number) => Math.max(0, qty - plan.includedQuantity);
  const overQty = overageQty(billingQty);
  const over = lineAmount(overQty, plan.overageRateNanos);
  const discount = 0 - roundDiv((base + over) * plan.discountBp, 10_000);
  const total = sum([base, over, discount], (a) => a + taxOn(a, taxBp));
  return { plan, taxBp, days, base, usage, billingQty, utcQty, overageQty, overQty, over, discount, total };
}

function reconcileGroup(lines: InvoiceLine[], ctx: Context): InvoiceResult[] {
  const { customerId, period } = lines[0]!;
  const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))];
  const primary = invoiceIds[0]!;
  const invoicedTotal = (id: string) => sum(lines.filter((l) => l.invoiceId === id), (l) => l.amountCents + l.taxCents - l.creditsCents);

  const findings: Finding[] = [];
  const add = (invoiceId: string, type: FindingType, f: NewFinding) => {
    const n = findings.filter((x) => x.invoiceId === invoiceId && x.type === type).length;
    findings.push({ id: `${invoiceId}:${type}${n ? `:${n + 1}` : ""}`, customerId, invoiceId, period, type, differenceCents: f.invoicedCents - f.expectedCents, ...f });
  };
  const results = (expected: Map<string, number>) =>
    invoiceIds.map((id) => result(id, customerId, period, findings.filter((f) => f.invoiceId === id), expected.get(id) ?? 0, invoicedTotal(id)));

  const segments = planSegments(ctx.plans.get(customerId) ?? [], period);
  if (segments.length === 0 || segments[0]!.from !== `${period}-01`) {
    for (const id of invoiceIds) {
      add(id, "missing_plan", {
        severity: "error",
        expectedCents: 0,
        invoicedCents: invoicedTotal(id),
        summary: `No plan terms cover the start of ${period} for ${customerId}, so the invoice cannot be checked.`,
        facts: { period },
      });
    }
    return results(new Map());
  }

  const t = terms(customerId, period, segments, ctx);
  const { plan, taxBp } = t;

  // 1. Duplicate lines, across all of the customer's invoices for the period. Later checks use the de-duplicated lines.
  const key = (x: InvoiceLine) =>
    [x.lineItem, x.description.toLowerCase(), x.quantity, x.amountCents, x.taxCents, x.creditsCents, x.creditMemoId].join("|");
  const unique: InvoiceLine[] = [];
  const dupes: { line: InvoiceLine; original: InvoiceLine }[] = [];
  for (const l of lines) {
    const original = unique.find((u) => key(u) === key(l));
    if (original) dupes.push({ line: l, original });
    else unique.push(l);
  }
  for (const [invoiceId, copies] of groupBy(dupes, (d) => d.line.invoiceId)) {
    const extra = sum(copies, (d) => d.line.amountCents + d.line.taxCents - d.line.creditsCents);
    const elsewhere = copies.find((d) => d.original.invoiceId !== invoiceId);
    add(invoiceId, "duplicate_line", {
      severity: "error",
      expectedCents: 0,
      invoicedCents: extra,
      summary: elsewhere
        ? `The ${copies.map((d) => d.line.lineItem).join(", ")} line was already billed on ${elsewhere.original.invoiceId}; billing it again adds ${formatCents(extra)} including tax.`
        : `The ${copies.map((d) => d.line.lineItem).join(", ")} line appears twice; the copy adds ${formatCents(extra)} including tax.`,
      facts: {
        duplicated_line: copies.map((d) => `${d.line.lineItem}: quantity ${d.line.quantity}, amount ${formatCents(d.line.amountCents)}, tax ${formatCents(d.line.taxCents)}`),
        extra_charge_including_tax: formatCents(extra),
        ...(elsewhere ? { first_billed_on: elsewhere.original.invoiceId } : {}),
      },
      quoted: { line_items: copies.map((d) => d.line.description) },
    });
  }
  const of = (item: InvoiceLine["lineItem"]) => unique.filter((l) => l.lineItem === item);
  const on = (item: InvoiceLine["lineItem"]) => of(item)[0]?.invoiceId ?? primary;
  const invoicedBase = sum(of("base"), (l) => l.amountCents);
  const invoicedOver = sum(of("overage"), (l) => l.amountCents);
  const invoicedOverQty = sum(of("overage"), (l) => l.quantity);
  const unmatched = of("other");

  if (unmatched.length) {
    // 2-4 together. A line that is not recognizably a base fee, overage or discount cannot be
    // checked on its own, so the charges are compared as a whole.
    const expectedSub = t.base + t.over + t.discount;
    const invoicedSub = sum(unique.filter((l) => l.lineItem !== "credit"), (l) => l.amountCents);
    if (invoicedSub !== expectedSub) {
      add(unmatched[0]!.invoiceId, "unrecognized_line", {
        severity: "error",
        expectedCents: expectedSub,
        invoicedCents: invoicedSub,
        summary: `${unmatched.length === 1 ? "1 line does" : `${unmatched.length} lines do`} not match the plan's base fee, overage or discount, so the charges were checked as a whole: they come to ${formatCents(invoicedSub)}; plan terms give ${formatCents(expectedSub)}.`,
        facts: {
          plan: `${plan.plan} at ${formatCents(plan.priceCents)}/month`,
          expected_base_fee: formatCents(t.base),
          expected_overage: formatCents(t.over),
          expected_discount: formatCents(t.discount),
          unmatched_line_amounts: unmatched.map((l) => formatCents(l.amountCents)),
        },
        quoted: { unmatched_line_items: unmatched.map((l) => l.description) },
      });
    }
  } else {
    // 2. Base fee, prorated by day across plan changes.
    if (invoicedBase !== t.base) {
      const fullMonthOf = segments.find((s) => s.plan.priceCents === invoicedBase);
      const isProration = segments.length > 1 && fullMonthOf !== undefined;
      add(on("base"), isProration ? "proration_error" : "base_mismatch", {
        severity: "error",
        expectedCents: t.base,
        invoicedCents: invoicedBase,
        summary: isProration
          ? `The plan changed mid-period but the base fee was billed at the ${fullMonthOf.plan.plan} price of ${formatCents(invoicedBase)} for the full month; the prorated base fee is ${formatCents(t.base)}.`
          : `The base fee is ${formatCents(invoicedBase)}; plan terms give ${formatCents(t.base)}.`,
        facts: {
          plan_segments: segments.map(
            (s) => `${s.plan.plan} at ${formatCents(s.plan.priceCents)}/month from ${s.from} to ${s.to} (${s.days} of ${t.days} days)`,
          ),
          ...(isProration ? { billed_as_full_month_of: fullMonthOf.plan.plan } : {}),
        },
      });
    }

    // 3. Usage overage.
    if (invoicedOver !== t.over || invoicedOverQty !== t.overQty) {
      const onTotal = invoicedOverQty === t.billingQty && t.billingQty !== t.overQty;
      const boundary = !onTotal && t.utcQty !== t.billingQty && invoicedOverQty === t.overageQty(t.utcQty);
      const boundaryRecords = t.usage.filter((u) => u.billingPeriod !== u.utcPeriod && (u.billingPeriod === period || u.utcPeriod === period));
      const type = onTotal ? "overage_on_total" : boundary ? "timezone_boundary" : "overage_mismatch";
      add(on("overage"), type, {
        severity: "error",
        expectedCents: t.over,
        invoicedCents: invoicedOver,
        summary:
          type === "overage_on_total"
            ? `Overage was charged on all ${units(t.billingQty)} units instead of the ${units(t.overQty)} units above the ${units(plan.includedQuantity)} included.`
            : type === "timezone_boundary"
              ? `Usage was assigned to months by the UTC calendar instead of the billing time zone (${BILLING_TIME_ZONE}); ${boundaryRecords.length === 1 ? "1 usage record" : `${boundaryRecords.length} usage records`} near midnight landed in the wrong period.`
              : `Overage is ${units(invoicedOverQty)} units for ${formatCents(invoicedOver)}; usage gives ${units(t.overQty)} units for ${formatCents(t.over)}.`,
        facts: {
          usage_in_period: t.billingQty,
          included_quantity: plan.includedQuantity,
          overage_rate_per_unit: formatRate(plan.overageRateNanos),
          expected_overage_units: t.overQty,
          invoiced_overage_units: invoicedOverQty,
          ...(type === "timezone_boundary"
            ? {
                usage_in_period_by_utc_calendar: t.utcQty,
                boundary_records: boundaryRecords.map(
                  (u) => `${u.quantity} units at ${u.timestamp} = ${u.localTime} billing time, belongs to ${u.billingPeriod}`,
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
      add(on("discount"), missing ? "discount_missing" : "discount_mismatch", {
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
  }

  // 5. Tax, recomputed on each invoice's own lines at the plan's state rate.
  for (const invoiceId of invoiceIds) {
    const own = unique.filter((l) => l.invoiceId === invoiceId);
    const taxAt = (bp: number) => sum(own, (l) => taxOn(l.amountCents, bp));
    const expectedTax = taxAt(taxBp);
    const invoicedTax = sum(own, (l) => l.taxCents);
    if (invoicedTax === expectedTax) continue;
    const chargedStates = Object.entries(STATE_TAX_BP)
      .filter(([state, bp]) => bp > 0 && state !== plan.taxState && taxAt(bp) === invoicedTax)
      .map(([state]) => state);
    const wrongState = invoicedTax !== 0 && chargedStates.length > 0;
    add(invoiceId, wrongState ? "tax_wrong_state" : "tax_mismatch", {
      severity: "error",
      expectedCents: expectedTax,
      invoicedCents: invoicedTax,
      summary: wrongState
        ? `Tax was charged at the ${chargedStates.join("/")} rate instead of the ${plan.taxState} rate of ${formatPct(taxBp)}.`
        : `Tax is ${formatCents(invoicedTax)}; ${plan.taxState} tax at ${formatPct(taxBp)} on these lines is ${formatCents(expectedTax)}.`,
      facts: {
        customer_tax_state: plan.taxState,
        correct_rate: formatPct(taxBp),
        ...(wrongState ? { rate_actually_charged: chargedStates.map((s) => `${s} ${formatPct(STATE_TAX_BP[s]!)}`) } : {}),
      },
    });
  }

  // 6. Credits. A credit is legitimate only if it cites an approved memo for this customer, period
  // and amount that no other invoice has already used.
  const approved = new Map<string, number>();
  for (const l of unique.filter((x) => x.creditsCents !== 0 || x.creditMemoId)) {
    const memo = ctx.memos.get(l.creditMemoId);
    const problem = creditProblem(l, memo, ctx);
    const memoAmount = problem === undefined || problem.countsMemo ? memo!.amountCents : 0;
    if (memoAmount) {
      approved.set(l.invoiceId, (approved.get(l.invoiceId) ?? 0) + memoAmount);
      ctx.memoUses.set(l.creditMemoId, l.invoiceId);
    }
    add(l.invoiceId, problem ? "unsupported_credit" : "credit_applied", {
      severity: problem ? "error" : "explained",
      expectedCents: 0 - memoAmount,
      invoicedCents: 0 - l.creditsCents,
      summary: problem
        ? `A ${formatCents(l.creditsCents)} credit ${problem.text}.`
        : `The invoice is ${formatCents(l.creditsCents)} lower because approved credit memo ${memo!.creditMemoId} was applied.`,
      facts: {
        credit_on_invoice: formatCents(l.creditsCents),
        credit_memo_id: l.creditMemoId || "(none)",
        ...(memo
          ? { memo_customer: memo.customerId, memo_period: memo.period, memo_amount: formatCents(memo.amountCents), memo_approved_by: memo.approvedBy || "(no approver)" }
          : {}),
      },
      ...(memo ? { quoted: { memo_reason: memo.reason } } : {}),
    });
  }

  // The plan's charges belong on the first invoice; each invoice is reduced by the credits approved on it.
  const expected = new Map(invoiceIds.map((id) => [id, (id === primary ? t.total : 0) - (approved.get(id) ?? 0)]));

  // 7. Approved credits larger than the charges would take the invoice below zero.
  for (const [invoiceId, total] of expected) {
    if (total >= 0 || !approved.get(invoiceId) || invoicedTotal(invoiceId) >= 0) continue;
    add(invoiceId, "credit_exceeds_charges", {
      severity: "error",
      expectedCents: 0,
      invoicedCents: invoicedTotal(invoiceId),
      summary: `Approved credits of ${formatCents(approved.get(invoiceId)!)} exceed the invoice's charges, leaving a total of ${formatCents(invoicedTotal(invoiceId))}; an invoice should not go below zero, so the excess belongs on the account as a credit balance.`,
      facts: { approved_credits: formatCents(approved.get(invoiceId)!), invoice_total: formatCents(invoicedTotal(invoiceId)) },
    });
    expected.set(invoiceId, 0);
  }

  return results(expected);
}

/** A customer with plan terms for the period and no invoice at all. */
function unbilled(customerId: string, period: string, segments: Segment[], ctx: Context): InvoiceResult {
  const t = terms(customerId, period, segments, ctx);
  const inv = { invoiceId: `NOT-INVOICED-${customerId}-${period}`, customerId, period };
  const findings = [
    finding(inv, "unbilled", {
      severity: "error",
      expectedCents: t.total,
      invoicedCents: 0,
      summary: `${customerId} has plan terms${t.billingQty ? " and usage" : ""} for ${period} but no invoice; plan terms give ${formatCents(t.total)} including tax.`,
      facts: {
        plan: `${t.plan.plan} at ${formatCents(t.plan.priceCents)}/month`,
        usage_in_period: t.billingQty,
        expected_base_fee: formatCents(t.base),
        expected_overage: formatCents(t.over),
        expected_discount: formatCents(t.discount),
      },
    }),
  ];
  return { ...inv, findings, ...totals(findings, t.total, 0) };
}

function finding(inv: { invoiceId: string; customerId: string; period: string }, type: FindingType, f: NewFinding): Finding {
  return { id: `${inv.invoiceId}:${type}`, customerId: inv.customerId, invoiceId: inv.invoiceId, period: inv.period, type, differenceCents: f.invoicedCents - f.expectedCents, ...f };
}

function creditProblem(line: InvoiceLine, memo: CreditMemo | undefined, ctx: Context): { text: string; countsMemo: boolean } | undefined {
  const id = line.creditMemoId;
  if (!id) return { text: "has no credit memo reference", countsMemo: false };
  const rejected = ctx.rejectedMemos.get(id);
  if (rejected) return { text: `cites credit memo ${id}, which could not be accepted (${rejected.line})`, countsMemo: false };
  if (!memo) return { text: `cites credit memo ${id}, which does not exist`, countsMemo: false };
  if (memo.customerId !== line.customerId) return { text: `cites credit memo ${id}, which belongs to ${memo.customerId}`, countsMemo: false };
  if (memo.period !== line.period) return { text: `cites credit memo ${id}, which was approved for ${memo.period}`, countsMemo: false };
  if (!memo.approvedBy) return { text: `cites credit memo ${id}, which has no approver`, countsMemo: false };
  const usedOn = ctx.memoUses.get(id);
  if (usedOn) return { text: `cites credit memo ${id}, which was already applied on ${usedOn}`, countsMemo: false };
  if (memo.amountCents !== line.creditsCents) return { text: `does not match credit memo ${id}, which approved ${formatCents(memo.amountCents)}`, countsMemo: true };
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
  return { invoiceId, customerId, period, findings, ...totals(findings, expectedTotalCents, invoicedTotalCents) };
}

function totals(findings: Finding[], expectedTotalCents: number, invoicedTotalCents: number) {
  const status: InvoiceResult["status"] = findings.some((f) => f.severity === "error") ? "flagged" : findings.length ? "explained" : "clean";
  return { status, expectedTotalCents, invoicedTotalCents, differenceCents: invoicedTotalCents - expectedTotalCents };
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((acc, x) => acc + f(x), 0);
const units = (n: number) => n.toLocaleString("en-US");
const formatPct = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
/** 30,000,000 nano-dollars -> "$0.03"; 12,500 -> "$0.0000125". At least two decimals, no trailing zeros beyond that. */
function formatRate(nanos: number): string {
  const whole = Math.floor(nanos / 1e9);
  const frac = String(nanos % 1e9).padStart(9, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${frac}`;
}
