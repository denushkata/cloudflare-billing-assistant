import { describe, expect, it } from "vitest";
import sampleInvoices from "../sample-data/invoices.csv";
import { explainFindings, inventedAmounts, promptFacts, type AiRunner } from "../src/ai";
import worker from "../src/index";
import type { Finding } from "../src/recon/reconcile";
import { fakeLedgers } from "./helpers";

const finding = (id: string, overrides: Partial<Finding> = {}): Finding => ({
  id,
  customerId: "C003",
  invoiceId: "INV-1",
  period: "2026-10",
  type: "discount_missing",
  severity: "error",
  expectedCents: -7500,
  invoicedCents: 0,
  differenceCents: 7500,
  summary: "The contract's 15% discount (-$75.00) is not on the invoice.",
  facts: { contract_discount: "15%", subtotal_before_discount: "$500.00" },
  ...overrides,
});

const reply = (text = "The 15% discount of $75.00 was not applied.") => ({
  response: { explanation: text, likely_cause: "Contract terms were not synced to billing.", suggested_fix: "Issue a credit." },
});

const fakeAi = (behave: (input: Record<string, unknown>) => Promise<unknown>): AiRunner & { calls: number } => {
  const ai = { calls: 0, run: (_m: string, input: Record<string, unknown>) => (ai.calls++, behave(input)) };
  return ai;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("explainFindings", () => {
  it("returns the model's explanation when the reply is valid", async () => {
    const out = await explainFindings(fakeAi(async () => reply()), [finding("a")]);
    expect(out.get("a")).toEqual({
      status: "ok",
      explanation: "The 15% discount of $75.00 was not applied.",
      likelyCause: "Contract terms were not synced to billing.",
      suggestedFix: "Issue a credit.",
    });
  });

  it("accepts a JSON string reply", async () => {
    const out = await explainFindings(fakeAi(async () => ({ response: JSON.stringify(reply().response) })), [finding("a")]);
    expect(out.get("a")?.status).toBe("ok");
  });

  it("degrades each failure mode to 'unavailable' without affecting the others", async () => {
    const findings = ["ok", "error", "slow", "garbage", "invented"].map((id) => finding(id, { invoiceId: id }));
    const ai = fakeAi(async (input) => {
      const which = JSON.parse((input.messages as { content: string }[])[1]!.content).invoice_id;
      if (which === "error") throw new Error("5xx");
      if (which === "slow") await sleep(500);
      if (which === "garbage") return { response: "not json" };
      if (which === "invented") return reply("The customer is owed $82.50 after a 16% adjustment.");
      return reply();
    });
    const out = await explainFindings(ai, findings, {}, 100);
    expect(out.get("ok")?.status).toBe("ok");
    expect(out.get("error")).toEqual({ status: "unavailable", note: "Explanation unavailable: the AI service returned an error." });
    expect(out.get("slow")).toEqual({ status: "unavailable", note: "Explanation unavailable: no reply within 0.1s." });
    expect(out.get("garbage")).toEqual({ status: "unavailable", note: "Explanation unavailable: the model returned an unreadable reply." });
    expect(out.get("invented")).toEqual({
      status: "unavailable",
      note: "Explanation unavailable: the model introduced amounts not in the facts ($82.50, 16%).",
    });
  });

  it("runs the calls in parallel", async () => {
    const ai = fakeAi(async () => (await sleep(100), reply()));
    const started = Date.now();
    await explainFindings(ai, ["a", "b", "c", "d", "e"].map((id) => finding(id)));
    expect(ai.calls).toBe(5);
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe("guardrail and prompt", () => {
  it("allows amounts from the facts in any sign or format and rejects new ones", () => {
    const facts = JSON.stringify(promptFacts(finding("a")));
    expect(inventedAmounts("A -$75.00 discount, i.e. $75, at 15%.", facts)).toEqual([]);
    expect(inventedAmounts("Refund $75.01 or 15.5%.", facts)).toEqual(["$75.01", "15.5%"]);
  });

  it("gives the model formatted amounts only, never raw cents", () => {
    const facts = promptFacts(finding("a"));
    expect(facts).toMatchObject({
      expected: "-$75.00",
      invoiced: "$0.00",
      difference: "$75.00",
      direction: "customer overcharged",
      standard_remedy: "corrected invoice or credit to the customer",
    });
    expect(JSON.stringify(facts)).not.toContain("Cents");
  });

  it("picks the remedy from the direction of the difference", () => {
    const remedy = (o: Partial<Finding>) => promptFacts(finding("a", o)).standard_remedy;
    expect(remedy({ differenceCents: -2000 })).toBe("corrected invoice or supplemental charge for the shortfall");
    expect(remedy({ severity: "explained", differenceCents: 0 })).toBe("none: the invoice is correct");
  });
});

describe("POST /api/reconcile", () => {
  const call = (body: unknown, ai: AiRunner) =>
    worker.fetch(new Request("http://x/api/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { AI: ai, LEDGER: fakeLedgers() });

  it("returns full calculated results for the demo even when Workers AI is down", async () => {
    const res = await call({ sample: true }, fakeAi(async () => { throw new Error("down"); }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.counts).toEqual({ invoices: 10, clean: 3, explained: 1, flagged: 6 });
    const findings = data.invoices.flatMap((i: any) => i.findings);
    expect(findings).toHaveLength(7);
    for (const f of findings) {
      expect(f.summary).toBeTruthy();
      expect(f.ai).toEqual({ status: "unavailable", note: "Explanation unavailable: the AI service returned an error." });
    }
  });

  it("attaches explanations and sends one AI call per finding", async () => {
    const ai = fakeAi(async () => ({ response: { explanation: "x", likely_cause: "y", suggested_fix: "z" } }));
    const data = (await (await call({ sample: true }, ai)).json()) as any;
    expect(ai.calls).toBe(7);
    expect(data.invoices[0].findings[0].ai.status).toBe("ok");
    expect(data.sources).toEqual({ usage: "sample", plans: "sample", invoices: "sample", creditMemos: "sample" });
  });

  it("rejects uploads without usage and invoices", async () => {
    const res = await call({ files: { usage: "customer_id,timestamp,product,quantity\n" } }, fakeAi(async () => reply()));
    expect(res.status).toBe(400);
  });

  it("refuses a file it cannot read as a whole, naming the file and the problem", async () => {
    const res = await call(
      { files: { usage: "customer_id,timestamp,product,quantity\nC1,yesterday,gb,5\n", invoices: "invoice_id\n" } },
      fakeAi(async () => reply()),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/^invoices\.csv: missing column\(s\) customer_id/);
  });

  it("lists rows it could not read with file and line, and checks the rest", async () => {
    const res = await call(
      { files: { usage: "customer_id,timestamp,product,quantity\nC001,yesterday,bandwidth_gb,5\n", invoices: sampleInvoices } },
      fakeAi(async () => reply()),
    );
    const d = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(d.rejected).toEqual([
      { line: "usage.csv line 2", reason: 'timestamp "yesterday" must be an ISO 8601 date and time with a time zone, e.g. 2026-10-15T12:00:00Z' },
    ]);
    expect(d.notices).toContain("C001 was not checked: 1 of its rows could not be read (usage.csv line 2).");
  });
});
