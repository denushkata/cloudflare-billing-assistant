import { describe, expect, it } from "vitest";
import { explainFindings, type AiRunner } from "../src/ai";
import { DEMO_HISTORY } from "../src/demo";
import worker, { type AppEnv } from "../src/index";
import { Ledger, type Precedent } from "../src/ledger";
import type { Finding } from "../src/recon/reconcile";
import { fakeLedgers, memorySql } from "./helpers";

const finding = (o: Partial<Finding> = {}): Finding => ({
  id: "INV-2026-10-004:tax_wrong_state",
  customerId: "C004",
  invoiceId: "INV-2026-10-004",
  period: "2026-10",
  type: "tax_wrong_state",
  severity: "error",
  expectedCents: 3562,
  invoicedCents: 3973,
  differenceCents: 411,
  summary: "Tax was charged at the CA rate instead of the WA rate of 6.5%.",
  facts: {},
  ...o,
});
const T1 = "2026-10-28T10:00:00Z";
const T2 = "2026-10-28T11:00:00Z";

describe("Ledger", () => {
  it("records new findings as open (or explained) with a 'detected' audit event", () => {
    const l = new Ledger(memorySql());
    const [a, b] = l.record(
      [
        { finding: finding(), explanation: "x" },
        { finding: finding({ id: "INV-7:credit_applied", type: "credit_applied", severity: "explained" }), explanation: null },
      ],
      T1,
    );
    expect(a).toMatchObject({ status: "open", explanation: "x", firstSeenAt: T1, differenceCents: 411 });
    expect(b!.status).toBe("explained");
    expect(l.history().events.map((e) => [e.issueKey, e.action, e.actor])).toEqual([
      ["INV-7:credit_applied", "detected", "system"],
      ["INV-2026-10-004:tax_wrong_state", "detected", "system"],
    ]);
  });

  it("re-running the same data does not duplicate issues or overwrite a decision", () => {
    const l = new Ledger(memorySql());
    l.record([{ finding: finding(), explanation: "first" }], T1);
    l.decide(finding().id, "resolved", "Credit issued", "a.analyst", T1);
    const [again] = l.record([{ finding: finding(), explanation: null }], T2);
    expect(again).toMatchObject({ status: "resolved", note: "Credit issued", explanation: "first", lastSeenAt: T2 });
    expect(l.history().issues).toHaveLength(1);
    expect(l.history().events.filter((e) => e.action === "detected")).toHaveLength(1);
  });

  it("keeps an audit trail of every decision", () => {
    const l = new Ledger(memorySql());
    l.record([{ finding: finding(), explanation: null }], T1);
    l.decide(finding().id, "escalated", "Needs tax team", "a.analyst", T1);
    const issue = l.decide(finding().id, "resolved", "  Credit issued  ", "b.analyst", T2);
    expect(issue).toMatchObject({ status: "resolved", note: "Credit issued", decidedBy: "b.analyst", decidedAt: T2 });
    expect(l.history().events.map((e) => [e.action, e.actor, e.note])).toEqual([
      ["resolved", "b.analyst", "Credit issued"],
      ["escalated", "a.analyst", "Needs tax team"],
      ["detected", "system", ""],
    ]);
  });

  it.each([
    ["an unknown status", { status: "deleted" }, "status must be resolved or escalated"],
    ["no analyst name", { analyst: " " }, "analyst name is required"],
    ["a very long note", { note: "x".repeat(1001) }, "note is longer than 1000"],
    ["an unknown issue", { key: "nope" }, "no issue nope"],
  ])("rejects a decision with %s", (_, o, message) => {
    const l = new Ledger(memorySql());
    l.record([{ finding: finding(), explanation: null }], T1);
    const a = { key: finding().id, status: "resolved", note: "", analyst: "a", ...o };
    expect(() => l.decide(a.key, a.status as never, a.note, a.analyst, T1)).toThrow(message);
  });

  it("does not accept decisions on explained items", () => {
    const l = new Ledger(memorySql());
    const f = finding({ id: "INV-7:credit_applied", type: "credit_applied", severity: "explained" });
    l.record([{ finding: f, explanation: null }], T1);
    expect(() => l.decide(f.id, "resolved", "", "a", T1)).toThrow("need no decision");
  });

  it("finds the most recent decided issue of the same type from an earlier period", () => {
    const l = new Ledger(memorySql());
    const past = (period: string, decided: boolean, type: Finding["type"] = "tax_wrong_state") => {
      const f = finding({ id: `INV-${period}:${type}`, invoiceId: `INV-${period}`, period, type });
      l.record([{ finding: f, explanation: null }], T1);
      if (decided) l.decide(f.id, "resolved", `fixed ${period}`, "a", `${period}-28T00:00:00Z`);
    };
    past("2026-07", true);
    past("2026-08", true);
    past("2026-09", false); // open, not a precedent
    past("2026-09", true, "discount_missing"); // different type
    past("2026-11", true); // later period
    const p = l.precedents([finding()])[finding().id]!;
    expect(p).toMatchObject({ period: "2026-08", status: "resolved", note: "fixed 2026-08", decidedBy: "a" });
    expect(l.precedents([finding({ type: "duplicate_line" })])).toEqual({});
  });

  it("seeds idempotently and resets", () => {
    const l = new Ledger(memorySql());
    l.seed(DEMO_HISTORY.C004!);
    l.seed(DEMO_HISTORY.C004!);
    expect(l.history().issues).toHaveLength(1);
    expect(l.history().events.map((e) => e.action)).toEqual(["resolved", "seeded"]);
    l.reset();
    expect(l.history()).toEqual({ issues: [], events: [] });
  });
});

describe("precedent in the AI prompt", () => {
  const precedent: Precedent = {
    issueKey: "INV-2026-09-004:tax_wrong_state",
    invoiceId: "INV-2026-09-004",
    period: "2026-09",
    type: "tax_wrong_state",
    status: "resolved",
    note: "Issued credit memo for $4.02. Also refund $9.99.",
    decidedBy: "m.chen",
    decidedAt: "2026-10-03T15:20:00Z",
    differenceCents: 402,
    summary: "",
  };
  const answer = (suggestion: string): AiRunner => ({
    run: async () => ({ response: { explanation: "e", likely_cause: "c", suggested_fix: "f", precedent_suggestion: suggestion } }),
  });

  it("returns the suggestion line when a precedent exists", async () => {
    const out = await explainFindings(answer("Same error in 2026-09, resolved with a $4.02 credit."), [finding()], { [finding().id]: precedent });
    expect(out.get(finding().id)).toMatchObject({ status: "ok", precedentSuggestion: "Same error in 2026-09, resolved with a $4.02 credit." });
  });

  it("drops a suggestion line when there is no precedent", async () => {
    const out = await explainFindings(answer("Seen before."), [finding()]);
    expect(out.get(finding().id)).not.toHaveProperty("precedentSuggestion");
  });

  it("does not trust amounts that appear only in an analyst's free-text note", async () => {
    const out = await explainFindings(answer("Last time we refunded $9.99."), [finding()], { [finding().id]: precedent });
    expect(out.get(finding().id)).toMatchObject({ status: "unavailable" });
  });
});

describe("persistence through the API", () => {
  const env = (ai?: AiRunner): AppEnv & { LEDGER: ReturnType<typeof fakeLedgers>; prompts: string[] } => {
    const prompts: string[] = [];
    return {
      prompts,
      LEDGER: fakeLedgers(),
      AI: ai ?? {
        run: async (_m, input) => {
          prompts.push((input.messages as { content: string }[])[1]!.content);
          return { response: { explanation: "e", likely_cause: "c", suggested_fix: "f", precedent_suggestion: "Seen in September." } };
        },
      },
    };
  };
  const post = (e: AppEnv, path: string, body: unknown) =>
    worker.fetch(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }), e);
  const get = (e: AppEnv, path: string) => worker.fetch(new Request(`http://x${path}`), e);
  const findingsOf = (data: any) => data.invoices.flatMap((i: any) => i.findings);
  const C004_KEY = "INV-2026-10-004:tax_wrong_state";

  it("demo run surfaces the seeded September precedent for C004 only", async () => {
    const e = env();
    const data = (await (await post(e, "/api/reconcile", { sample: true })).json()) as any;
    const withPrecedent = findingsOf(data).filter((f: any) => f.precedent);
    expect(withPrecedent.map((f: any) => f.id)).toEqual([C004_KEY]);
    expect(withPrecedent[0].precedent.summary).toBe(
      'Seen before in 2026-09 (INV-2026-09-004, $4.02): resolved by m.chen, note: "Issued credit memo CM-2026-0119 for $4.02 and corrected the account\'s tax state to WA.".',
    );
    expect(withPrecedent[0].ai.precedentSuggestion).toBe("Seen in September.");
    expect(e.prompts.filter((p) => p.includes("previous_occurrence"))).toHaveLength(1);
    expect(data.warnings).toEqual([]);
  });

  it("keeps the deterministic precedent line when the AI is down", async () => {
    const e = env({ run: async () => { throw new Error("down"); } });
    const data = (await (await post(e, "/api/reconcile", { sample: true })).json()) as any;
    const f = findingsOf(data).find((x: any) => x.id === C004_KEY);
    expect(f.ai.status).toBe("unavailable");
    expect(f.precedent.summary).toContain("Seen before in 2026-09");
  });

  it("stores decisions, shows them on later runs, and lists them in history", async () => {
    const e = env();
    await post(e, "/api/reconcile", { sample: true });
    const res = await post(e, "/api/customers/C001/decisions", {
      issueKey: "INV-2026-10-001:proration_error",
      status: "escalated",
      note: "Needs billing-system fix",
      analyst: "d.krasteva",
    });
    expect(res.status).toBe(200);
    const rerun = (await (await post(e, "/api/reconcile", { sample: true })).json()) as any;
    expect(findingsOf(rerun).find((f: any) => f.customerId === "C001")).toMatchObject({
      status: "escalated",
      note: "Needs billing-system fix",
      decidedBy: "d.krasteva",
    });
    const history = (await (await get(e, "/api/customers/C001/history")).json()) as any;
    expect(history.issues).toHaveLength(1);
    expect(history.events.map((x: any) => x.action)).toEqual(["escalated", "detected"]);
  });

  it("rejects bad decisions with a clear message", async () => {
    const e = env();
    await post(e, "/api/reconcile", { sample: true });
    const res = await post(e, "/api/customers/C007/decisions", { issueKey: "INV-2026-10-007:credit_applied", status: "resolved", analyst: "a" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/need no decision/);
    expect((await get(e, "/api/customers/bad%20id/history")).status).toBe(400);
  });

  it("demo reset clears decisions and restores the seed", async () => {
    const e = env();
    await post(e, "/api/reconcile", { sample: true });
    await post(e, "/api/customers/C004/decisions", { issueKey: C004_KEY, status: "resolved", analyst: "a" });
    expect((await post(e, "/api/demo/reset", {})).status).toBe(200);
    const history = (await (await get(e, "/api/customers/C004/history")).json()) as any;
    expect(history.issues.map((i: any) => i.key)).toEqual(["INV-2026-09-004:tax_wrong_state"]);
  });

  it("still returns full results when storage is unavailable", async () => {
    const e = env();
    e.LEDGER.get = () => { throw new Error("storage down"); };
    const res = await post(e, "/api/reconcile", { sample: true });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.counts.flagged).toBe(6);
    expect(findingsOf(data)).toHaveLength(7);
    expect(data.warnings).toContain("History for C004 could not be read.");
  });
});
