import { describe, expect, it } from "vitest";
import { inventedNumbers, narrateInsights, type AiRunner } from "../src/ai";
import worker, { type AppEnv } from "../src/index";
import { computeInsights, insightFacts, type InsightIssue } from "../src/insights";
import { fakeLedgers } from "./helpers";

const SAMPLE_CUSTOMERS = ["C001", "C002", "C003", "C004", "C005", "C006", "C007", "C008", "C009", "C010"];
const env = (ai?: AiRunner): AppEnv => ({
  LEDGER: fakeLedgers(),
  AI: ai ?? { run: async () => ({ response: { explanation: "e", likely_cause: "c", suggested_fix: "f", precedent_suggestion: "", summary: "s" } }) },
});
const post = (e: AppEnv, path: string, body: unknown) =>
  worker.fetch(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), e);
const insights = async (e: AppEnv, customers = SAMPLE_CUSTOMERS, period = "2026-10") =>
  worker.fetch(new Request(`http://x/api/insights?period=${period}&customers=${customers.join(",")}`), e);

describe("insights for the sample data", () => {
  it("match the expected-results table on a fresh demo run", async () => {
    const e = env();
    await post(e, "/api/reconcile", { sample: true });
    const { insights: x } = (await (await insights(e)).json()) as any;

    expect(x.issues).toBe(6);
    expect(x.exposure).toEqual({
      overchargedCents: { open: 61091, escalated: 0, resolved: 0, total: 61091 },
      underchargedCents: { open: 17484, escalated: 0, resolved: 0, total: 17484 },
    });
    expect(x.rootCauses.map((r: any) => [r.type, r.count, r.totalCents])).toEqual([
      ["overage_on_total", 1, 50000],
      ["proration_error", 1, 15484],
      ["discount_missing", 1, 7500],
      ["duplicate_line", 1, 3180],
      ["timezone_boundary", 1, 2000],
      ["tax_wrong_state", 1, 411],
    ]);
    expect(x.recurrence).toEqual({
      repeats: 1,
      of: 6,
      percent: 17,
      keys: ["INV-2026-10-004:tax_wrong_state"],
      issues: [{ key: "INV-2026-10-004:tax_wrong_state", customerId: "C004", label: "wrong-state sales tax" }],
    });
    expect(x.hotspots.map((h: any) => [h.customerId, h.openCents, h.repeats])).toEqual([
      ["C002", 50000, 0],
      ["C001", 15484, 0],
      ["C003", 7500, 0],
      ["C005", 3180, 0],
      ["C006", 2000, 0],
      ["C004", 411, 1],
    ]);
    expect(x.aging.buckets).toEqual([
      { label: "0–2 days", count: 6 },
      { label: "3–7 days", count: 0 },
      { label: "8+ days", count: 0 },
    ]);
    expect(x.medianHoursToResolve).toBeNull();
    expect(x.summary).toBe(
      "6 issues in 2026-10: $610.91 overcharged and $174.84 undercharged. Largest: overage charged on total usage ($500.00). 1 of 6 is a repeat of an earlier decided issue.",
    );
  });

  it("move exposure between statuses as decisions are made", async () => {
    const e = env();
    await post(e, "/api/reconcile", { sample: true });
    await post(e, "/api/customers/C002/decisions", { issueKey: "INV-2026-10-002:overage_on_total", status: "resolved", note: "Credit issued", analyst: "a" });
    await post(e, "/api/customers/C001/decisions", { issueKey: "INV-2026-10-001:proration_error", status: "escalated", note: "Needs billing fix", analyst: "a" });
    const { insights: x } = (await (await insights(e)).json()) as any;
    expect(x.exposure.overchargedCents).toEqual({ open: 11091, escalated: 0, resolved: 50000, total: 61091 });
    expect(x.exposure.underchargedCents).toEqual({ open: 2000, escalated: 15484, resolved: 0, total: 17484 });
    expect(x.hotspots.map((h: any) => h.customerId)).toEqual(["C001", "C003", "C005", "C006", "C004"]);
    expect(x.medianHoursToResolve).toBeGreaterThanOrEqual(0);
  });

  it("rejects a bad period or customer list", async () => {
    const e = env();
    expect((await insights(e, SAMPLE_CUSTOMERS, "2026-13")).status).toBe(400);
    expect((await insights(e, ["C001", "bad id"])).status).toBe(400);
    expect((await insights(e, [])).status).toBe(400);
  });
});

describe("computeInsights edge cases", () => {
  const issue = (o: Partial<InsightIssue>): InsightIssue => ({
    key: "k",
    customerId: "C1",
    invoiceId: "INV",
    period: "2026-10",
    type: "tax_wrong_state",
    severity: "error",
    expectedCents: 0,
    invoicedCents: 0,
    differenceCents: 100,
    summary: "",
    explanation: null,
    status: "open",
    note: "",
    decidedBy: null,
    decidedAt: null,
    firstSeenAt: "2026-10-28T00:00:00Z",
    lastSeenAt: "2026-10-28T00:00:00Z",
    ...o,
  });
  const NOW = "2026-10-28T12:00:00Z";

  it("buckets open and escalated issues by age across all periods and names the oldest", () => {
    const x = computeInsights(
      [
        issue({ key: "a", firstSeenAt: "2026-10-27T12:00:00Z" }), // 1 day
        issue({ key: "b", firstSeenAt: "2026-10-23T12:00:00Z", status: "escalated" }), // 5 days
        issue({ key: "c", firstSeenAt: "2026-10-18T12:00:00Z", period: "2026-09" }), // 10 days, earlier period
        issue({ key: "d", firstSeenAt: "2026-09-01T00:00:00Z", status: "resolved", decidedAt: "2026-09-02T00:00:00Z" }), // resolved: not aged
        issue({ key: "e", severity: "explained", status: "explained" }), // explained: never counted
      ],
      "2026-10",
      NOW,
    );
    expect(x.aging.buckets.map((b) => b.count)).toEqual([1, 1, 1]);
    expect(x.aging.oldest).toEqual({ key: "c", customerId: "C1", ageDays: 10, status: "open" });
    expect(x.issues).toBe(3); // a, b, d are in 2026-10; e is explained
  });

  it("takes the median time to resolve", () => {
    const resolved = (key: string, hours: number) =>
      issue({ key, status: "resolved", firstSeenAt: "2026-10-01T00:00:00Z", decidedAt: new Date(Date.parse("2026-10-01T00:00:00Z") + hours * 3_600_000).toISOString() });
    expect(computeInsights([resolved("a", 2), resolved("b", 10), resolved("c", 4)], "2026-10", NOW).medianHoursToResolve).toBe(4);
    expect(computeInsights([resolved("a", 2), resolved("b", 5)], "2026-10", NOW).medianHoursToResolve).toBe(3.5);
  });

  it("counts a repeat only for the same customer and type, from an earlier decided issue", () => {
    const x = computeInsights(
      [
        issue({ key: "now-1", customerId: "C1" }),
        issue({ key: "now-2", customerId: "C2" }),
        issue({ key: "now-3", customerId: "C3" }),
        issue({ key: "past-1", customerId: "C1", period: "2026-09", status: "resolved" }), // makes now-1 a repeat
        issue({ key: "past-2", customerId: "C2", period: "2026-09", status: "open" }), // undecided: no
        issue({ key: "past-3", customerId: "C1", period: "2026-09", type: "discount_missing", status: "resolved" }), // other type: no
      ],
      "2026-10",
      NOW,
    );
    expect(x.recurrence).toMatchObject({ repeats: 1, of: 3, percent: 33, keys: ["now-1"] });
  });

  it("splits undercharges from overcharges", () => {
    const x = computeInsights([issue({ key: "u", differenceCents: -250 }), issue({ key: "o", differenceCents: 400 })], "2026-10", NOW);
    expect(x.exposure.underchargedCents.total).toBe(250);
    expect(x.exposure.overchargedCents.total).toBe(400);
    expect(x.rootCauses[0]).toMatchObject({ underchargedCents: 250, overchargedCents: 400, totalCents: 650, count: 2 });
  });

  it("says so plainly when there are no errors", () => {
    expect(computeInsights([], "2026-10", NOW).summary).toBe("No billing errors found for 2026-10.");
  });
});

describe("insights narrative", () => {
  const facts = () => {
    const x = computeInsights(
      [
        { key: "a", customerId: "C2", invoiceId: "I", period: "2026-10", type: "overage_on_total", severity: "error", expectedCents: 0, invoicedCents: 0, differenceCents: 50000, summary: "", explanation: null, status: "open", note: "", decidedBy: null, decidedAt: null, firstSeenAt: "2026-10-28T00:00:00Z", lastSeenAt: "2026-10-28T00:00:00Z" },
      ],
      "2026-10",
      "2026-10-28T01:00:00Z",
    );
    return insightFacts(x);
  };
  const saying = (summary: string): AiRunner => ({ run: async () => ({ response: { summary } }) });

  it("passes a summary that only repeats numbers from the metrics", async () => {
    const out = await narrateInsights(saying("All $500.00 of exposure in 2026-10 comes from 1 issue: overage charged on total usage for C2."), facts());
    expect(out).toEqual({ status: "ok", text: "All $500.00 of exposure in 2026-10 comes from 1 issue: overage charged on total usage for C2." });
  });

  it("rejects a summary with a number the code did not compute", async () => {
    const out = await narrateInsights(saying("Exposure grew 40% to $500.00."), facts());
    expect(out).toEqual({ status: "unavailable", note: "Summary unavailable: the model introduced numbers not in the metrics (40)." });
  });

  it("rejects links and survives errors and timeouts", async () => {
    expect((await narrateInsights(saying("See billing.example.com/report"), facts())).status).toBe("unavailable");
    expect((await narrateInsights({ run: async () => { throw new Error("down"); } }, facts())).status).toBe("unavailable");
    const slow: AiRunner = { run: () => new Promise((r) => setTimeout(() => r({ response: { summary: "late" } }), 200)) };
    expect(await narrateInsights(slow, facts(), 50)).toEqual({ status: "unavailable", note: "Summary unavailable: no reply within 0.05s." });
  });

  it("says when the Workers AI daily allowance is used up", async () => {
    const quota: AiRunner = { run: async () => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); } };
    expect(await narrateInsights(quota, facts())).toEqual({
      status: "unavailable",
      note: "Summary unavailable: the Workers AI daily allowance is used up (it resets at 00:00 UTC).",
    });
  });

  it("compares numbers regardless of thousands separators", () => {
    expect(inventedNumbers("$1,206.56 across 12,500 units", '"$1206.56" "12500"')).toEqual([]);
  });

  it("is served from the API and falls back cleanly when the AI is down", async () => {
    const e = env({ run: async () => { throw new Error("down"); } });
    await post(e, "/api/reconcile", { sample: true });
    const res = await post(e, "/api/insights/narrative", { period: "2026-10", customers: SAMPLE_CUSTOMERS });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).narrative).toEqual({ status: "unavailable", note: "Summary unavailable: the AI service returned an error." });
  });
});
