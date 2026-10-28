import { describe, expect, it } from "vitest";
import creditMemos from "../sample-data/credit_memos.csv";
import invoices from "../sample-data/invoices.csv";
import plans from "../sample-data/plans.csv";
import usage from "../sample-data/usage.csv";
import { explainFindings, MAX_AI_CALLS, type AiRunner } from "../src/ai";
import worker, { type AppEnv } from "../src/index";
import { Ledger } from "../src/ledger";
import { parseInputs } from "../src/recon/model";
import type { Finding } from "../src/recon/reconcile";
import { safeAnalystName, safeText } from "../src/safety";
import { fakeLedgers, memorySql } from "./helpers";

const T1 = "2026-10-28T10:00:00Z";
const finding = (o: Partial<Finding> = {}): Finding => ({
  id: "INV-1:tax_wrong_state",
  customerId: "C004",
  invoiceId: "INV-1",
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
const note = (text: string) => () => safeText(text, "note", { max: 1000 });

describe("free text: links, phishing and hidden characters", () => {
  it.each([
    "See https://billing-portal.example/fix",
    "see http://evil.test",
    "go to www.refund-now.com",
    "visit evil.com for details",
    "portal at billing-help.co/login",
    "click javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "email refunds@attacker.net",
    "mailto:refunds@attacker.net",
    "<a href=x>click</a>",
    "<img src=x onerror=alert(1)>",
    "[urgent](http://x)",
    'Refund via =HYPERLINK("http://x","here")',
  ])("refuses a note containing a link or markup: %s", (text) => {
    expect(note(text)).toThrow(/cannot contain links/);
  });

  it.each([
    ["right-to-left override (Trojan Source)", "Resolved ‮redlof‬"],
    ["zero-width space", "Cred​it issued"],
    ["null byte", "ok\u0000"],
    ["escape character", "\u001b[31mred"],
  ])("refuses a note with a %s", (_, text) => {
    expect(note(text)).toThrow(/hidden or control characters/);
  });

  it.each([
    "Issued credit memo CM-2026-0119 for $4.02 and corrected the account's tax state to WA.",
    "Per ticket BILL-123, contract v2.1 terms applied; e.g. see memo.",
    "Sent to billing ops.\nWaiting on tax team.",
    "Customer called 2026-10-09 at 3.30pm",
    "'; DROP TABLE issues; --",
  ])("accepts an ordinary note: %s", (text) => {
    expect(note(text)()).toBe(text);
  });

  it("limits note length", () => {
    expect(note("x".repeat(1001))).toThrow(/longer than 1000/);
  });

  it.each(["d.krasteva", "Mary O'Neil", "José García", "j_smith-2"])("accepts analyst name %s", (n) => {
    expect(safeAnalystName(n)).toBe(n);
  });

  it.each(["", "evil.com", "a@b.co", "<b>x</b>", "http://x", "Bob‮", "=cmd", "x".repeat(101)])(
    "refuses analyst name %j",
    (n) => {
      expect(() => safeAnalystName(n)).toThrow(/analyst name/);
    },
  );
});

describe("ledger: injection and tampering", () => {
  const ledger = () => {
    const sql = memorySql();
    const l = new Ledger(sql);
    l.record([{ finding: finding(), explanation: null }], T1);
    return { l, sql };
  };

  it("stores SQL-like text literally because every query is parameterized", () => {
    const { l } = ledger();
    l.decide(finding().id, "resolved", "x'); DELETE FROM events; --", "a", T1);
    const h = l.history();
    expect(h.issues[0]!.note).toBe("x'); DELETE FROM events; --");
    expect(h.events.map((e) => e.action)).toEqual(["resolved", "detected"]);
  });

  it("treats an injected issue key as a plain value", () => {
    const { l } = ledger();
    expect(() => l.decide("x' OR '1'='1", "resolved", "n", "a", T1)).toThrow("no issue x' OR '1'='1");
    expect(l.history().issues[0]!.status).toBe("open");
  });

  it("refuses links and bad names on decisions", () => {
    const { l } = ledger();
    expect(() => l.decide(finding().id, "resolved", "Fixed, see https://x.test", "a", T1)).toThrow(/cannot contain links/);
    expect(() => l.decide(finding().id, "resolved", "Fixed", "admin@corp.com", T1)).toThrow(/analyst name/);
    expect(l.history().issues[0]!.status).toBe("open");
  });

  it("blocks edits to the audit trail at the database level", () => {
    const { l, sql } = ledger();
    l.decide(finding().id, "escalated", "Needs tax team", "a", T1);
    expect(() => sql.exec("UPDATE events SET actor = 'someone-else'")).toThrow(/append-only/);
  });

  it("blocks changing a resolved decision at the database level", () => {
    const { l, sql } = ledger();
    l.decide(finding().id, "resolved", "Credit issued", "a", T1);
    expect(() => sql.exec("UPDATE issues SET note = 'rewritten', decided_by = 'b'")).toThrow(/resolved issues are final/);
    expect(() => sql.exec("UPDATE issues SET status = 'open'")).toThrow(/resolved issues are final/);
    // Refreshing amounts on a re-run is still allowed.
    l.record([{ finding: finding({ summary: "updated" }), explanation: null }], T1);
    expect(l.history().issues[0]).toMatchObject({ status: "resolved", note: "Credit issued", summary: "updated" });
  });
});

describe("CSV uploads", () => {
  const parse = (o: Partial<Record<"usage" | "plans" | "invoices" | "creditMemos", string>>) =>
    () => parseInputs({ usage, plans, invoices, creditMemos, ...o });

  it("refuses IDs that are not plain identifiers", () => {
    expect(parse({ usage: usage.replace("C001,2026-10-05", "C001'; DROP--,2026-10-05") })).toThrow(/usage.csv line 2: customer_id/);
    expect(parse({ invoices: invoices.replace("INV-2026-10-001,", "<script>,") })).toThrow(/invoices.csv line 2: invoice_id/);
  });

  it("refuses links and hidden characters in memo reasons", () => {
    expect(parse({ creditMemos: creditMemos.replace("SLA credit for", "SLA credit, claim at https://x.test for") })).toThrow(
      /credit_memos.csv line 3: reason cannot contain links/,
    );
    expect(parse({ creditMemos: creditMemos.replace("SLA credit", "SLA‮ credit") })).toThrow(/hidden or control/);
  });

  it("refuses an approver name that is not a name", () => {
    expect(parse({ creditMemos: creditMemos.replace("j.alvarez", "approve@corp.com") })).toThrow(/analyst name/);
  });

  it("caps rows per file", () => {
    const big = "customer_id,timestamp,product,quantity\n" + "C001,2026-10-05T14:00:00Z,bandwidth_gb,1\n".repeat(20_001);
    expect(parse({ usage: big })).toThrow(/more than 20,000 rows/);
  });
});

describe("AI output and cost limits", () => {
  const replying = (explanation: string): AiRunner => ({
    run: async () => ({ response: { explanation, likely_cause: "c", suggested_fix: "f", precedent_suggestion: "" } }),
  });

  it.each([
    ["a link", "Customer should pay at https://pay.example.com"],
    ["an email address", "Contact refunds@billing-help.net"],
    ["HTML", "<script>alert(1)</script>"],
    ["hidden characters", "Tax​ error"],
  ])("discards a reply containing %s", async (_, text) => {
    const out = await explainFindings(replying(text), [finding()]);
    expect(out.get(finding().id)).toEqual({ status: "unavailable", note: "Explanation unavailable: the reply contained a link or hidden characters." });
  });

  it(`makes at most ${MAX_AI_CALLS} model calls per request`, async () => {
    let calls = 0;
    const ai: AiRunner = { run: async () => (calls++, { response: { explanation: "e", likely_cause: "c", suggested_fix: "f", precedent_suggestion: "" } }) };
    const many = Array.from({ length: MAX_AI_CALLS + 5 }, (_, i) => finding({ id: `INV-${i}:tax_wrong_state` }));
    const out = await explainFindings(ai, many);
    expect(calls).toBe(MAX_AI_CALLS);
    expect(out.get(`INV-${MAX_AI_CALLS + 4}:tax_wrong_state`)).toMatchObject({ status: "unavailable" });
  });
});

describe("API request hardening", () => {
  const env = (): AppEnv => ({
    LEDGER: fakeLedgers(),
    AI: { run: async () => ({ response: { explanation: "e", likely_cause: "c", suggested_fix: "f", precedent_suggestion: "" } }) },
  });
  const post = (path: string, body: string, headers: Record<string, string> = {}, e = env()) =>
    worker.fetch(new Request(`https://app.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }), e);

  it("refuses cross-origin and cross-site posts (CSRF)", async () => {
    expect((await post("/api/demo/reset", "{}", { origin: "https://evil.test" })).status).toBe(403);
    expect((await post("/api/demo/reset", "{}", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post("/api/demo/reset", "{}", { origin: "https://app.test" })).status).toBe(200);
  });

  it("refuses non-JSON posts, which a plain HTML form could send", async () => {
    const res = await post("/api/reconcile", '{"sample":true}', { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it("refuses oversized and malformed bodies", async () => {
    expect((await post("/api/reconcile", "{}", { "content-length": String(6 * 1024 * 1024) })).status).toBe(413);
    expect((await post("/api/reconcile", "[1,2]")).status).toBe(400);
    expect((await post("/api/reconcile", "not json")).status).toBe(400);
  });

  it("returns 400, not 500, for malformed or unsafe customer IDs in the URL", async () => {
    const e = env();
    for (const id of ["%E0%A4%A", "..%2F..%2Fetc", "C001%3Cscript%3E"]) {
      const res = await worker.fetch(new Request(`https://app.test/api/customers/${id}/history`), e);
      expect(res.status, id).toBe(400);
    }
  });

  it("refuses a decision with a link and says why", async () => {
    const e = env();
    await post("/api/reconcile", '{"sample":true}', {}, e);
    const res = await post(
      "/api/customers/C001/decisions",
      JSON.stringify({ issueKey: "INV-2026-10-001:proration_error", status: "resolved", note: "Paid, see bit.ly/abc", analyst: "a" }),
      {},
      e,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot contain links/);
  });

  it("sends security headers on API responses", async () => {
    const res = await post("/api/demo/reset", "{}");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
