import { parseCsv, type CsvRow } from "./csv";
import { parseBasisPoints, parseCents, parseMicros, parseWholeNumber } from "./money";
import { assertPeriod, periodsFor } from "./period";
import { STATE_TAX_BP } from "./tax";
import { safeAnalystName, safeId, safeText } from "../safety";

export interface UsageRecord {
  customerId: string;
  timestamp: string;
  product: string;
  quantity: number;
  billingPeriod: string; // month in the billing time zone
  utcPeriod: string; // month by UTC calendar
  localTime: string;
}

export interface Plan {
  customerId: string;
  plan: string;
  priceCents: number; // monthly base fee
  includedQuantity: number;
  overageRateMicros: number; // per unit above included quantity
  discountBp: number;
  taxState: string;
  effectiveDate: string; // YYYY-MM-DD, billing time zone
}

export const LINE_ITEMS = ["base", "overage", "discount", "credit"] as const;
export type LineItem = (typeof LINE_ITEMS)[number];

export interface InvoiceLine {
  invoiceId: string;
  customerId: string;
  period: string;
  lineItem: LineItem;
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
  approvedBy: string;
}

export interface ReconcileInput {
  usage: UsageRecord[];
  plans: Plan[];
  invoices: InvoiceLine[];
  creditMemos: CreditMemo[];
}

export interface CsvFiles {
  usage: string;
  plans: string;
  invoices: string;
  creditMemos: string;
}

/** Parse the four CSV files. Any malformed row throws with file and line number. */
export function parseInputs(files: CsvFiles): ReconcileInput {
  return {
    usage: rows(files.usage, "usage.csv", ["customer_id", "timestamp", "product", "quantity"], (r) => {
      const periods = periodsFor(r.timestamp!);
      return {
        customerId: id(r, "customer_id"),
        timestamp: r.timestamp!,
        product: id(r, "product"),
        quantity: parseWholeNumber(r.quantity!, "quantity"),
        billingPeriod: periods.billing,
        utcPeriod: periods.utc,
        localTime: periods.local,
      };
    }),
    plans: rows(
      files.plans,
      "plans.csv",
      ["customer_id", "plan", "price", "included_quantity", "overage_rate", "discount_pct", "tax_state", "effective_date"],
      (r) => {
        const taxState = r.tax_state!.toUpperCase();
        if (!(taxState in STATE_TAX_BP)) throw new Error(`tax_state "${r.tax_state}" has no rate in the tax table`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.effective_date!)) throw new Error(`effective_date "${r.effective_date}" must be YYYY-MM-DD`);
        return {
          customerId: id(r, "customer_id"),
          plan: safeText(r.plan, "plan", { max: 64, required: true }),
          priceCents: parseCents(r.price!, "price"),
          includedQuantity: parseWholeNumber(r.included_quantity!, "included_quantity"),
          overageRateMicros: parseMicros(r.overage_rate!, "overage_rate"),
          discountBp: parseBasisPoints(r.discount_pct || "0", "discount_pct"),
          taxState,
          effectiveDate: r.effective_date!,
        };
      },
    ),
    invoices: rows(
      files.invoices,
      "invoices.csv",
      ["invoice_id", "customer_id", "period", "line_item", "quantity", "amount", "tax", "credits", "credit_memo_id"],
      (r, source) => {
        assertPeriod(r.period!, "period");
        const lineItem = r.line_item!.toLowerCase() as LineItem;
        if (!LINE_ITEMS.includes(lineItem)) throw new Error(`line_item "${r.line_item}" must be one of ${LINE_ITEMS.join(", ")}`);
        return {
          invoiceId: id(r, "invoice_id"),
          customerId: id(r, "customer_id"),
          period: r.period!,
          lineItem,
          quantity: parseWholeNumber(r.quantity || "0", "quantity"),
          amountCents: parseCents(r.amount || "0", "amount"),
          taxCents: parseCents(r.tax || "0", "tax"),
          creditsCents: parseCents(r.credits || "0", "credits"),
          creditMemoId: r.credit_memo_id ? id(r, "credit_memo_id") : "",
          source,
        };
      },
    ),
    creditMemos: rows(
      files.creditMemos,
      "credit_memos.csv",
      ["credit_memo_id", "customer_id", "period", "amount", "reason", "approved_by"],
      (r) => {
        assertPeriod(r.period!, "period");
        return {
          creditMemoId: id(r, "credit_memo_id"),
          customerId: id(r, "customer_id"),
          period: r.period!,
          amountCents: parseCents(r.amount!, "amount"),
          reason: safeText(r.reason, "reason", { max: 200, required: true }),
          approvedBy: safeAnalystName(r.approved_by),
        };
      },
    ),
  };
}

/** Generous for a monthly reconciliation export, small enough to keep one request bounded. */
export const MAX_ROWS_PER_FILE = 20_000;

function rows<T>(text: string, fileName: string, columns: string[], map: (r: CsvRow, source: string) => T): T[] {
  const parsed = parseCsv(text, columns, fileName);
  if (parsed.length > MAX_ROWS_PER_FILE) throw new Error(`${fileName}: more than ${MAX_ROWS_PER_FILE.toLocaleString("en-US")} rows`);
  return parsed.map((r) => {
    try {
      return map(r, r.__line);
    } catch (e) {
      throw new Error(`${r.__line}: ${(e as Error).message}`);
    }
  });
}

function id(r: CsvRow, column: string): string {
  if (!r[column]) throw new Error(`${column} is empty`);
  return safeId(r[column]!, column);
}
