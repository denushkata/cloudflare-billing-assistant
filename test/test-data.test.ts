// Runs every set in test-data/ through the API exactly as an upload would, and checks the
// outcome for each case listed in test-data/README.md. Results are summarized in test-data/RESULTS.md.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { type AppEnv } from "../src/index";
import { fakeLedgers, fakeSessions } from "./helpers";

const dir = `${import.meta.dirname}/../test-data`;
const read = (path: string) => readFileSync(`${dir}/${path}`, "utf8");
const set = (folder: string) => ({
  usage: read(`${folder}/usage.csv`),
  plans: read(`${folder}/plans.csv`),
  invoices: read(`${folder}/invoices.csv`),
  creditMemos: read(`${folder}/credit_memos.csv`),
});
const env = (): AppEnv => ({ LEDGER: fakeLedgers(), SESSION: fakeSessions(), AI: { run: async () => { throw new Error("AI is not part of these checks"); } } });

async function check(files: object) {
  const res = await worker.fetch(
    new Request("http://x/api/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }) }),
    env(),
  );
  const data = (await res.json()) as any;
  /** customer -> "type:difference" for each finding, in order */
  const byCustomer = (id: string) =>
    data.invoices
      .filter((i: any) => i.customerId === id)
      .flatMap((i: any) => i.findings.map((f: any) => `${f.type}:${(f.differenceCents / 100).toFixed(2)}`));
  return { res, data, byCustomer };
}

describe("1-functional", () => {
  it.each([
    ["F01", [], "plan change on the 1st: full Pro price"],
    ["F02", [], "plan change on the last day: $96.77 + $10.00"],
    ["F03", [], "two plan changes: $32.26 + $96.77 + $220.00"],
    ["F04", [], "usage exactly equals included"],
    ["F05", [], "one unit over: $0.03 overage"],
    ["F06", [], "zero usage"],
    ["F07", [], "proration rounding 17/31 and 14/31"],
    ["F08", ["base_mismatch:-0.01"], "one cent short, no hidden tolerance"],
    ["F09", [], "100% discount nets to $0"],
    ["F10", ["duplicate_line:-60.00"], "20% discount applied twice"],
    ["F11", ["tax_mismatch:19.20"], "tax in a no-sales-tax state"],
    ["F12", ["unsupported_credit:-25.00"], "$75 credit against a $50 memo"],
    ["F13", ["unsupported_credit:-40.00"], "memo belongs to another customer"],
    ["F14", ["unsupported_credit:-40.00"], "memo is for August"],
    ["F15", ["unsupported_credit:-30.00"], "memo has no approver"],
    ["F16", ["credit_applied:0.00", "unrecognized_line:50.00", "unsupported_credit:-25.00"], "memo used on two invoices; the add-on is not in plan terms"],
    ["F17", ["credit_applied:0.00", "credit_exceeds_charges:-50.00"], "credit larger than the invoice"],
    ["F18", ["credit_not_applied:60.00"], "approved memo never applied"],
    ["F19-UNKNOWN", ["missing_plan:300.00"], "invoice for a customer with no plan"],
    ["F20", ["unbilled:-420.00"], "plan and usage but no invoice"],
    ["F21", [], "UTC month edges"],
    // By design: usage is assigned to the billing time zone (America/New_York), the spec's planted case 6.
    // 2026-10-31T21:30-04:00 is 9:30 PM on Oct 31 there, so it belongs to October. The README assumes UTC months.
    ["F22", ["timezone_boundary:-30.00"], "-04:00 offset: October in the billing time zone"],
    ["F23", [], "negative adjustment nets out"],
    ["F24", [], "2.23 billion requests at $0.0000125: $15,432.10"],
    ["F25", [], "second product is reported as unpriced"],
    ["F26", ["overage_mismatch:-90.00"], '" f26 " is read as F26; the missing $90 overage is flagged'],
    ["F27", ["duplicate_line:300.00"], "same plan line on two invoices"],
    ["F28", [], "next month's plan change ignored"],
    ["F29", ["base_mismatch:2700.00"], "billed $3,000 instead of $300"],
    ["F30", [], "clean baseline"],
  ])("%s: %s", async (customer, expected) => {
    const { byCustomer } = await check(set("1-functional"));
    expect(byCustomer(customer)).toEqual(expected);
  });

  it("states the rules it applied", async () => {
    const { data } = await check(set("1-functional"));
    expect(data.rejected).toEqual([]);
    expect(data.notices).toEqual([
      'Customer ID "f26" was read as F26; IDs are matched without regard to case or surrounding spaces.',
      "F23: -2,000 requests of usage adjustments in 2026-10 were netted against that month's usage.",
      "F25: 50 ai_neurons in 2026-10 has no price in the plan terms (the plan meters requests), so it was not checked.",
    ]);
  });

  it("files a duplicate or second memo use on the invoice that holds it", async () => {
    const { data } = await check(set("1-functional"));
    const status = (id: string) => data.invoices.find((i: any) => i.invoiceId === id).status;
    expect([status("INV-F27A"), status("INV-F27B"), status("INV-F16A"), status("INV-F16B")]).toEqual(["clean", "flagged", "explained", "flagged"]);
  });
});

describe("2-malformed (each file uploaded in place of the matching functional file)", () => {
  const swap = (file: string, as: string) => ({ ...set("1-functional"), [as]: read(`2-malformed/${file}`) });

  it.each([
    ["empty.csv", "invoices", "Upload usage.csv and invoices.csv, or use the sample data."],
    ["header_only_invoices.csv", "invoices", "invoices.csv: has a header but no data rows"],
    ["missing_column_invoices.csv", "invoices", "invoices.csv: missing column(s) amount"],
  ])("%s is refused with a clear error", async (file, as, error) => {
    const { res, data } = await check(swap(file, as));
    expect(res.status).toBe(400);
    expect(data.error).toBe(error);
  });

  it.each(["reordered_extra_columns_invoices.csv", "bom_crlf_invoices.csv", "duplicate_header_invoices.csv"])("%s still reads F30's invoice", async (file) => {
    const { byCustomer, data } = await check(swap(file, "invoices"));
    expect(byCustomer("F30")).toEqual([]);
    expect(data.rejected.map((r: any) => r.reason)).toEqual(file.startsWith("duplicate") ? ["repeats the header row"] : []);
  });

  it("bad_rows_invoices.csv lists each bad row and does not check F30 on partial data", async () => {
    const { data, byCustomer } = await check(swap("bad_rows_invoices.csv", "invoices"));
    expect(data.rejected.map((r: any) => `${r.line.replace("invoices.csv ", "")}: ${r.reason}`)).toEqual([
      "line 17: expected 9 fields, found 11",
      "line 18: expected 9 fields, found 3",
      "line 3: line_item contains a line break",
      'line 5: quantity: "ten" must be a whole number',
      'line 6: amount: "$1,234.50" is not a number',
      'line 7: amount: "1.234,50" is not a number',
      "line 8: amount is empty",
      'line 9: amount: "1e3" is not a number',
      'line 10: amount: "NaN" is not a number',
      'line 11: amount: "Infinity" is not a number',
      'line 13: period: "10/2026" must look like 2026-10',
      'line 14: period: "2026-13" must look like 2026-10',
      'line 15: amount: "100.005" has more than 2 decimal places',
      'line 16: customer_id "" must be 1-64 letters, digits, ".", "_" or "-"',
    ]);
    expect(byCustomer("F30")).toEqual([]);
    expect(data.notices).toContain("F30 was not checked: 13 of its rows could not be read (invoices.csv line 17; invoices.csv line 18; invoices.csv line 3; …).");
  });

  it("bad_rows_usage.csv rejects every row", async () => {
    const { data } = await check(swap("bad_rows_usage.csv", "usage"));
    expect(data.rejected.map((r: any) => r.reason.split(" must ")[0].split(" is ")[0])).toEqual([
      'timestamp "10/15/2026 3:00 PM"',
      'timestamp "2026-02-30T00:00:00Z"',
      'timestamp "2026-10-15"',
      'timestamp "2026-10-15T12:00:00"',
      'timestamp "1760000000"',
      'timestamp ""',
      'quantity: "1.5"',
      "product",
      'quantity: "9007199254740993"',
    ]);
  });

  it("bad_rows_plans.csv rejects impossible terms and ambiguous dates, and accepts a lowercase state", async () => {
    const { data, byCustomer } = await check(swap("bad_rows_plans.csv", "plans"));
    expect(data.rejected.map((r: any) => `${r.line}: ${r.reason}`)).toEqual([
      'plans.csv line 2: discount_pct "150" must be between 0 and 100',
      'plans.csv line 3: discount_pct "-10" must be between 0 and 100',
      "plans.csv line 4: price cannot be negative",
      'plans.csv line 5: tax_state "XX" has no rate in the tax table',
      "plans.csv line 8: M6 has two plans effective 2026-10-01 (also line 7); which applies is ambiguous",
    ]);
    expect(byCustomer("M5")).toEqual(["unbilled:-300.00"]); // "or" read as OR
  });

  it("credit_memos_bad.csv rejects a negative memo, a non-numeric amount and every copy of a duplicated ID", async () => {
    const { data, byCustomer } = await check(swap("credit_memos_bad.csv", "creditMemos"));
    expect(data.rejected.map((r: any) => `${r.line}: ${r.reason}`)).toEqual([
      'credit_memos.csv line 2: amount "-50.00" must be more than zero',
      'credit_memos.csv line 4: amount: "abc" is not a number',
      "credit_memos.csv line 3: credit memo ID CM-M1 appears more than once",
    ]);
    expect(byCustomer("F30")).toEqual([]); // the surviving copy of CM-M1 is not treated as owed
  });
});

describe("3-security", () => {
  it("refuses hostile IDs and markup, keeps every value as plain data, and checks what remains", async () => {
    const { data, byCustomer } = await check(set("3-security"));
    expect(data.rejectedCount).toBe(55);
    const checked = data.invoices.map((i: any) => i.customerId);
    expect(checked).toEqual(["CONSTRUCTOR", "PROTOTYPE", "HASOWNPROPERTY", "TOSTRING", "S04", "S07", "S08", "S11", "S12", "S13", "S15", "P01", "P02", "P04"]);
    // The quoted newline in S-HDR never becomes a row, so the fake $999,999 credit never exists.
    expect(JSON.stringify(data)).not.toContain("999999");
    expect(checked).not.toContain("FAKE");
    // A lookalike is shown as an escape so it cannot pass for S01 or C01.
    expect(data.rejected.map((r: any) => r.reason)).toContain('customer_id "\\u042101" must be 1-64 letters, digits, ".", "_" or "-"');
    // Off by $15 to $30 as designed; the text in the line item is quoted to the reviewer and model as data.
    expect(byCustomer("S07")).toEqual(["unrecognized_line:20.00"]);
    const s07 = data.invoices.find((i: any) => i.customerId === "S07").findings[0];
    expect(s07.quoted).toEqual({ unmatched_line_items: ["{{7*7}} ${7*7} <%= 7*7 %>"] });
    // P01's memo has a script tag for an approver, so the credit citing it is not supported.
    expect(byCustomer("P01")).toEqual(["unrecognized_line:60.00", "unsupported_credit:-45.00"]);
  });

  it("caps an oversized field before it reaches the model", async () => {
    const { data } = await check(set("3-security"));
    expect(data.rejected).toContainEqual({ line: "invoices.csv line 41", reason: "line_item is longer than 200 characters" });
  });
});

describe("4-stress", () => {
  it("many_exceptions: all 500 calculated results return, and AI calls stop at 50", async () => {
    let calls = 0;
    const e: AppEnv = { LEDGER: fakeLedgers(), SESSION: fakeSessions(), AI: { run: async () => { calls++; throw new Error("4006: daily free allocation"); } } };
    const res = await worker.fetch(
      new Request("http://x/api/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: set("4-stress/many_exceptions") }) }),
      e,
    );
    const data = (await res.json()) as any;
    expect(data.counts).toEqual({ invoices: 500, clean: 0, explained: 0, flagged: 500 });
    expect(new Set(data.invoices.map((i: any) => i.differenceCents))).toEqual(new Set([100]));
    expect(calls).toBe(50);
    const notes = data.invoices.map((i: any) => i.findings[0].ai.note);
    expect(notes[0]).toBe("Explanation unavailable: the Workers AI daily allowance is used up (it resets at 00:00 UTC).");
    expect(notes[499]).toBe("Explanation unavailable: only the first 50 findings are explained per check.");
  });

  it("large_usage: more than 5 MB is refused with a clear size error", async () => {
    // usage.csv for this set is not committed (see generate-usage.mjs); the same size is built here.
    const usage = "customer_id,timestamp,product,quantity\n" + "L0000,2026-10-11T04:25:00Z,requests,2\n".repeat(200_000);
    const { res, data } = await check({ ...set("4-stress/many_exceptions"), usage });
    expect(res.status).toBe(413);
    expect(data.error).toMatch(/^The files together are larger than 5 MB/);
  });
});
