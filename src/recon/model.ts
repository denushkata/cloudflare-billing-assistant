import { parseCsv, type CsvRow } from "./csv";
import { parseBasisPoints, parseCents, parseNanos, parseWholeNumber } from "./money";
import { assertPeriod, periodsFor } from "./period";
import { hasTaxRate } from "./tax";
import { ID_PATTERN, safeAnalystName, safeId, safeText, visibleText } from "../safety";

export interface UsageRecord {
  customerId: string;
  timestamp: string;
  product: string;
  /** Negative for an adjustment; records net out within the period. */
  quantity: number;
  billingPeriod: string; // month in the billing time zone
  utcPeriod: string; // month by UTC calendar
  localTime: string;
}

export interface Plan {
  customerId: string;
  plan: string;
  /** The metered product the overage applies to. */
  product: string;
  priceCents: number; // monthly base fee
  includedQuantity: number;
  overageRateNanos: number; // per unit above included quantity
  discountBp: number;
  taxState: string;
  effectiveDate: string; // YYYY-MM-DD, billing time zone
  source: string;
}

/** What an invoice line is for, read from the start of its line_item text ("Plan: Pro" is a base fee). */
export type LineItem = "base" | "overage" | "discount" | "credit" | "other";
const LINE_KINDS: [RegExp, LineItem][] = [
  [/^(base|plan)\b/i, "base"],
  [/^(overage|usage)\b/i, "overage"],
  [/^discount\b/i, "discount"],
  [/^credit\b/i, "credit"],
];

export interface InvoiceLine {
  invoiceId: string;
  customerId: string;
  period: string;
  lineItem: LineItem;
  /** The line_item text as written; quoted to the reviewer and the model, never interpreted. */
  description: string;
  quantity: number;
  amountCents: number;
  taxCents: number;
  creditsCents: number;
  creditMemoId: string;
  source: string;
}

export interface CreditMemo {
  creditMemoId: string;
  customerId: string;
  period: string;
  amountCents: number;
  reason: string;
  /** Empty when no one approved it; such a memo cannot back a credit. */
  approvedBy: string;
  source: string;
}

export interface RejectedRow {
  /** "usage.csv line 7" */
  line: string;
  reason: string;
  customerId?: string;
  creditMemoId?: string;
}

export interface ReconcileInput {
  usage: UsageRecord[];
  plans: Plan[];
  invoices: InvoiceLine[];
  creditMemos: CreditMemo[];
  /** Rows that could not be read. A customer with a rejected plan, usage or invoice row is not checked. */
  rejected: RejectedRow[];
  /** Plain statements about how the data was read, shown to the reviewer. */
  notices: string[];
}

export interface CsvFiles {
  usage: string;
  plans: string;
  invoices: string;
  creditMemos: string;
}

/** Generous for a monthly reconciliation export, small enough to keep one request bounded. */
export const MAX_ROWS_PER_FILE = 20_000;
const MAX_LINE_ITEM = 200;

/**
 * Parse the four CSV files. A file that cannot be read as a whole (empty, missing a column, too
 * many rows) throws. A row that cannot be read is rejected with its line number and reason, and
 * the rest of the file is still used.
 */
export function parseInputs(files: CsvFiles): ReconcileInput {
  const rejected: RejectedRow[] = [];
  const renamed = new Map<string, string>();
  const customerId = (r: CsvRow) => {
    const raw = r.customer_id ?? "";
    const id = safeId(raw, "customer_id").toUpperCase(); // IDs match regardless of case: " f26 " is F26
    if (raw !== id) renamed.set(raw, id);
    return id;
  };

  const rows = <T>(text: string, fileName: string, columns: string[], map: (r: CsvRow) => T, { required = true } = {}): T[] => {
    const parsed = parseCsv(text, columns, fileName);
    if (parsed.rows.length + parsed.errors.length > MAX_ROWS_PER_FILE) {
      throw new Error(`${fileName}: more than ${MAX_ROWS_PER_FILE.toLocaleString("en-US")} rows`);
    }
    if (required && !parsed.rows.length && !parsed.errors.length) throw new Error(`${fileName}: has a header but no data rows`);
    for (const e of parsed.errors) rejected.push({ ...e, customerId: readableId(e.customerId) });
    const out: T[] = [];
    for (const r of parsed.rows) {
      try {
        out.push(map(r));
      } catch (e) {
        rejected.push({
          line: r.__line,
          reason: visibleText((e as Error).message),
          customerId: readableId(r.customer_id),
          ...(fileName === "credit_memos.csv" && r.credit_memo_id && ID_PATTERN.test(r.credit_memo_id) ? { creditMemoId: r.credit_memo_id } : {}),
        });
      }
    }
    return out;
  };

  const usage = rows(
    files.usage,
    "usage.csv",
    ["customer_id", "timestamp", "product", "quantity"],
    (r) => {
      const periods = periodsFor(r.timestamp!);
      return {
        customerId: customerId(r),
        timestamp: r.timestamp!,
        product: id(r, "product").toLowerCase(),
        quantity: parseWholeNumber(r.quantity!, "quantity", { signed: true }),
        billingPeriod: periods.billing,
        utcPeriod: periods.utc,
        localTime: periods.local,
      };
    },
    { required: false },
  );

  // Plans name their metered product in an optional "product" column; otherwise it is the product
  // most usage rows report. Usage of any other product is reported as unpriced, never dropped silently.
  const defaultProduct = mostCommon(usage.map((u) => u.product)) ?? "";
  const plans = rows(
    files.plans,
    "plans.csv",
    ["customer_id", "plan", "price", "included_quantity", "overage_rate", "discount_pct", "tax_state", "effective_date"],
    (r) => {
      const taxState = r.tax_state!.toUpperCase();
      if (!hasTaxRate(taxState)) throw new Error(`tax_state "${r.tax_state}" has no rate in the tax table`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.effective_date!)) throw new Error(`effective_date "${r.effective_date}" must be YYYY-MM-DD`);
      const discountBp = parseBasisPoints(r.discount_pct || "0", "discount_pct");
      if (discountBp < 0 || discountBp > 10_000) throw new Error(`discount_pct "${r.discount_pct}" must be between 0 and 100`);
      const plan = {
        customerId: customerId(r),
        plan: safeText(r.plan, "plan", { max: 64, required: true }),
        product: r.product ? id(r, "product").toLowerCase() : defaultProduct,
        priceCents: nonNegative(parseCents(r.price!, "price"), "price"),
        includedQuantity: parseWholeNumber(r.included_quantity!, "included_quantity"),
        overageRateNanos: nonNegative(parseNanos(r.overage_rate!, "overage_rate"), "overage_rate"),
        discountBp,
        taxState,
        effectiveDate: r.effective_date!,
        source: r.__line,
      };
      return plan;
    },
  );
  // Two plans for one customer starting the same day leave the price ambiguous.
  const seen = new Map<string, Plan>();
  for (const p of plans) {
    const key = `${p.customerId}|${p.effectiveDate}`;
    const first = seen.get(key);
    if (first) {
      rejected.push({ line: p.source, reason: `${p.customerId} has two plans effective ${p.effectiveDate} (also ${first.source.replace("plans.csv ", "")}); which applies is ambiguous`, customerId: p.customerId });
    } else seen.set(key, p);
  }

  const invoices = rows(
    files.invoices,
    "invoices.csv",
    ["invoice_id", "customer_id", "period", "line_item", "quantity", "amount", "tax", "credits", "credit_memo_id"],
    (r) => {
      assertPeriod(r.period!, "period");
      const description = safeText(r.line_item, "line_item", { max: MAX_LINE_ITEM, required: true });
      if (description.includes("\n")) throw new Error("line_item contains a line break");
      if (!r.amount) throw new Error("amount is empty");
      return {
        invoiceId: id(r, "invoice_id"),
        customerId: customerId(r),
        period: r.period!,
        lineItem: LINE_KINDS.find(([re]) => re.test(description))?.[1] ?? "other",
        description,
        quantity: parseWholeNumber(r.quantity || "0", "quantity"),
        amountCents: parseCents(r.amount, "amount"),
        taxCents: parseCents(r.tax || "0", "tax"),
        creditsCents: nonNegative(parseCents(r.credits || "0", "credits"), "credits"),
        creditMemoId: r.credit_memo_id ? id(r, "credit_memo_id") : "",
        source: r.__line,
      };
    },
  );

  const creditMemos = rows(
    files.creditMemos,
    "credit_memos.csv",
    ["credit_memo_id", "customer_id", "period", "amount", "reason", "approved_by"],
    (r) => {
      assertPeriod(r.period!, "period");
      const amountCents = parseCents(r.amount!, "amount");
      if (amountCents <= 0) throw new Error(`amount "${r.amount}" must be more than zero`);
      return {
        creditMemoId: id(r, "credit_memo_id"),
        customerId: customerId(r),
        period: r.period!,
        amountCents,
        reason: safeText(r.reason, "reason", { max: 200, required: true }),
        approvedBy: r.approved_by ? safeAnalystName(r.approved_by) : "",
        source: r.__line,
      };
    },
    { required: false },
  );
  // A memo ID used twice cannot be trusted either way; every copy is rejected, including one already rejected for another reason.
  const memoCounts = countBy([...creditMemos.map((m) => m.creditMemoId), ...rejected.flatMap((r) => (r.creditMemoId ? [r.creditMemoId] : []))]);
  const memos = creditMemos.filter((m) => {
    if (memoCounts.get(m.creditMemoId)! < 2) return true;
    rejected.push({ line: m.source, reason: `credit memo ID ${m.creditMemoId} appears more than once`, customerId: m.customerId, creditMemoId: m.creditMemoId });
    return false;
  });

  const notices = [...renamed].map(([raw, id]) => `Customer ID "${raw}" was read as ${id}; IDs are matched without regard to case or surrounding spaces.`);
  return { usage, plans, invoices, creditMemos: memos, rejected, notices };
}

function id(r: CsvRow, column: string): string {
  if (!r[column]) throw new Error(`${column} is empty`);
  return safeId(r[column]!, column);
}

/** The upper-cased ID if the raw text is a valid ID, so a broken row can still be tied to its customer. */
function readableId(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  return s && ID_PATTERN.test(s) ? s.toUpperCase() : undefined;
}

function nonNegative(n: number, field: string): number {
  if (n < 0) throw new Error(`${field} cannot be negative`);
  return n;
}

function countBy(xs: string[]) {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function mostCommon(xs: string[]): string | undefined {
  return [...countBy(xs)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}
