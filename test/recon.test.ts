import { describe, expect, it } from "vitest";
import creditMemos from "../sample-data/credit_memos.csv";
import invoices from "../sample-data/invoices.csv";
import plans from "../sample-data/plans.csv";
import usage from "../sample-data/usage.csv";
import { parseCsv } from "../src/recon/csv";
import { parseInputs, type ReconcileInput } from "../src/recon/model";
import { parseCents, roundDiv } from "../src/recon/money";
import { periodsFor } from "../src/recon/period";
import { reconcile } from "../src/recon/reconcile";

const sample = (): ReconcileInput => parseInputs({ usage, plans, invoices, creditMemos });

const run = (input = sample()) => reconcile(input);
const invoice = (id: string, input?: ReconcileInput) => {
  const inv = run(input).invoices.find((i) => i.invoiceId === id);
  if (!inv) throw new Error(`no invoice ${id}`);
  return inv;
};
const only = (id: string, input?: ReconcileInput) => {
  const inv = invoice(id, input);
  expect(inv.findings).toHaveLength(1);
  return inv.findings[0]!;
};

describe("planted cases in the sample data", () => {
  it("1. mid-month plan change billed at the old price for the full month", () => {
    const f = only("INV-2026-10-001");
    expect(f.type).toBe("proration_error");
    expect(f.expectedCents).toBe(35484); // (200 x 15 + 500 x 16) / 31 days
    expect(f.invoicedCents).toBe(20000);
    expect(f.differenceCents).toBe(-15484);
    expect(f.facts.billed_as_full_month_of).toBe("Starter");
  });

  it("2. overage charged on total usage instead of usage above the included amount", () => {
    const f = only("INV-2026-10-002");
    expect(f.type).toBe("overage_on_total");
    expect(f.expectedCents).toBe(12500); // 2,500 GB x $0.05
    expect(f.invoicedCents).toBe(62500); // 12,500 GB x $0.05
    expect(f.differenceCents).toBe(50000);
  });

  it("3. contract discount not applied", () => {
    const f = only("INV-2026-10-003");
    expect(f.type).toBe("discount_missing");
    expect(f.expectedCents).toBe(-7500);
    expect(f.invoicedCents).toBe(0);
    expect(f.differenceCents).toBe(7500);
  });

  it("4. sales tax for the wrong state", () => {
    const f = only("INV-2026-10-004");
    expect(f.type).toBe("tax_wrong_state");
    expect(f.expectedCents).toBe(3562); // WA 6.5%
    expect(f.invoicedCents).toBe(3973); // CA 7.25%
    expect(f.differenceCents).toBe(411);
    expect(f.facts.rate_actually_charged).toEqual(["CA 7.25%"]);
  });

  it("5. duplicate invoice line", () => {
    const f = only("INV-2026-10-005");
    expect(f.type).toBe("duplicate_line");
    expect(f.invoicedCents).toBe(3180); // $30.00 overage + $1.80 tax
    expect(f.differenceCents).toBe(3180);
  });

  it("6. usage at 11:30 PM ET on Oct 31 is November in UTC and was left off the October invoice", () => {
    const f = only("INV-2026-10-006");
    expect(f.type).toBe("timezone_boundary");
    expect(f.expectedCents).toBe(4000); // 800 GB over
    expect(f.invoicedCents).toBe(2000); // 400 GB over, UTC calendar
    expect(f.differenceCents).toBe(-2000);
    expect(f.facts.boundary_records).toEqual([
      "400 units at 2026-11-01T03:30:00Z UTC = 2026-10-31 23:30 billing time, belongs to 2026-10",
    ]);
  });

  it("7. a lower invoice backed by an approved credit memo is explained, not flagged", () => {
    const inv = invoice("INV-2026-10-007");
    expect(inv.status).toBe("explained");
    expect(inv.differenceCents).toBe(0);
    const f = only("INV-2026-10-007");
    expect(f.type).toBe("credit_applied");
    expect(f.severity).toBe("explained");
    expect(f.differenceCents).toBe(0);
  });

  it("8. clean invoices pass with no findings", () => {
    for (const id of ["INV-2026-10-008", "INV-2026-10-009", "INV-2026-10-010"]) {
      const inv = invoice(id);
      expect(inv.status, id).toBe("clean");
      expect(inv.findings, id).toEqual([]);
      expect(inv.differenceCents, id).toBe(0);
    }
  });

  it("produces exactly the planted findings and nothing else", () => {
    const r = run();
    expect(r.counts).toEqual({ invoices: 10, clean: 3, explained: 1, flagged: 6 });
    expect(r.findings.map((f) => f.type)).toEqual([
      "proration_error",
      "overage_on_total",
      "discount_missing",
      "tax_wrong_state",
      "duplicate_line",
      "timezone_boundary",
      "credit_applied",
    ]);
  });

  it("invoice-level totals match the expected-results table", () => {
    const totals = Object.fromEntries(
      run().invoices.map((i) => [i.invoiceId, [i.expectedTotalCents, i.invoicedTotalCents, i.differenceCents]]),
    );
    expect(totals).toEqual({
      "INV-2026-10-001": [37702, 21250, -16452],
      "INV-2026-10-002": [120656, 174281, 53625],
      "INV-2026-10-003": [44200, 52000, 7800],
      "INV-2026-10-004": [58362, 58773, 411],
      "INV-2026-10-005": [24380, 27560, 3180],
      "INV-2026-10-006": [110500, 108375, -2125],
      "INV-2026-10-007": [46450, 46450, 0],
      "INV-2026-10-008": [21250, 21250, 0],
      "INV-2026-10-009": [98280, 98280, 0],
      "INV-2026-10-010": [55770, 55770, 0],
    });
  });
});

describe("credits", () => {
  const withCreditLine = (patch: Partial<ReconcileInput["invoices"][number]>) => {
    const input = sample();
    const line = input.invoices.find((l) => l.invoiceId === "INV-2026-10-007" && l.lineItem === "credit")!;
    Object.assign(line, patch);
    return input;
  };

  it.each([
    ["no memo reference", { creditMemoId: "" }, "has no credit memo reference", 0],
    ["unknown memo", { creditMemoId: "CM-9999" }, "does not exist", 0],
    ["memo for another customer", { creditMemoId: "CM-2026-0119" }, "belongs to C004", 0],
    ["amount above the approved memo", { creditsCents: 7500 }, "which approved $50.00", -5000],
  ])("flags a credit with %s", (_, patch, text, expectedCents) => {
    const f = only("INV-2026-10-007", withCreditLine(patch));
    expect(f.type).toBe("unsupported_credit");
    expect(f.severity).toBe("error");
    expect(f.summary).toContain(text);
    expect(f.expectedCents).toBe(expectedCents);
  });
});

describe("correct invoices with tricky terms stay clean", () => {
  it("accepts a correctly prorated mid-month upgrade", () => {
    const input = sample();
    const base = input.invoices.find((l) => l.invoiceId === "INV-2026-10-001")!;
    base.amountCents = 35484;
    base.taxCents = 2218;
    expect(invoice("INV-2026-10-001", input).status).toBe("clean");
  });

  it("accepts prorated base split across two lines", () => {
    const input = sample();
    const base = input.invoices.find((l) => l.invoiceId === "INV-2026-10-001")!;
    Object.assign(base, { amountCents: 9677, taxCents: 605 }); // Starter, 15 days
    input.invoices.push({ ...base, amountCents: 25807, taxCents: 1613 }); // Pro, 16 days
    expect(invoice("INV-2026-10-001", input).status).toBe("clean");
  });
});

describe("helpers", () => {
  it("rounds half away from zero in integer math", () => {
    expect(roundDiv(5, 10)).toBe(1);
    expect(roundDiv(4, 10)).toBe(0);
    expect(roundDiv(-5, 10)).toBe(-1);
    expect(roundDiv(-4, 10)).toBe(0);
    expect(Object.is(roundDiv(-4, 10), 0)).toBe(true); // no negative zero
    expect(roundDiv(453125, 10000)).toBe(45);
  });

  it("parses money from strings without floating point", () => {
    expect(parseCents("0.29", "x")).toBe(29);
    expect(parseCents("-105.00", "x")).toBe(-10500);
    expect(parseCents("12", "x")).toBe(1200);
    expect(() => parseCents("1.005", "x")).toThrow(/decimal places/);
    expect(() => parseCents("1e3", "x")).toThrow(/not a number/);
  });

  it("assigns usage to the billing-time-zone month across DST", () => {
    expect(periodsFor("2026-11-01T03:30:00Z").billing).toBe("2026-10"); // EDT, UTC-4
    expect(periodsFor("2026-11-01T04:30:00Z").billing).toBe("2026-11");
    expect(periodsFor("2026-12-01T04:30:00Z").billing).toBe("2026-11"); // EST, UTC-5
    expect(() => periodsFor("2026-10-01 12:00")).toThrow(/UTC/);
  });

  it("reads quoted CSV fields and reports bad rows with line numbers", () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n', ["a", "b"], "t.csv");
    expect(rows[0]).toMatchObject({ a: "x, y", b: 'say "hi"' });
    expect(() => parseCsv("a,b\n1\n", ["a", "b"], "t.csv")).toThrow("t.csv line 2");
    expect(() => parseCsv("a\n1\n", ["a", "b"], "t.csv")).toThrow("missing column(s) b");
  });

  it("names the file and line when a value is malformed", () => {
    const files = { usage, plans, creditMemos, invoices: invoices.replace("200.00,12.50", "200.00,abc") };
    expect(() => parseInputs(files)).toThrow('invoices.csv line 2: tax: "abc" is not a number');
  });
});
