// Coordination lives here and in the per-customer Durable Objects:
//   parse -> calculate -> look up precedents (per customer) -> explain each finding (in parallel)
//   -> record to each customer's ledger -> respond.
// Calculation never depends on the AI or storage steps; if either fails, results still return.

import sampleCreditMemos from "../sample-data/credit_memos.csv";
import sampleInvoices from "../sample-data/invoices.csv";
import samplePlans from "../sample-data/plans.csv";
import sampleUsage from "../sample-data/usage.csv";
import { AI_TIMEOUT_MS, explainFindings, ISSUE_NAMES, MODEL, narrateInsights, type AiRunner, type Explanation } from "./ai";
import { computeInsights, insightFacts, type InsightIssue } from "./insights";
import { DEMO_HISTORY, PLANTED_CASES } from "./demo";
import type { Decision, Issue, Ledger, Precedent } from "./ledger";
import { parseInputs, type CsvFiles } from "./recon/model";
import { ID_PATTERN } from "./safety";
import { reconcile, type Finding } from "./recon/reconcile";

export { CustomerLedger } from "./customer-do";

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<R> | R : never };
export type LedgerStub = Async<Pick<Ledger, "precedents" | "record" | "history" | "seed" | "reset">> & {
  decide(...a: Parameters<Ledger["decide"]>): Promise<{ issue?: Issue; error?: string }> | { issue?: Issue; error?: string };
};

export interface AppEnv {
  AI: AiRunner;
  LEDGER: { idFromName(name: string): unknown; get(id: never): LedgerStub };
}

const SAMPLE: CsvFiles = { usage: sampleUsage, plans: samplePlans, invoices: sampleInvoices, creditMemos: sampleCreditMemos };
const SAMPLE_CUSTOMERS = [...new Set(parseInputs(SAMPLE).plans.map((p) => p.customerId))];
const CUSTOMER_ID = ID_PATTERN;
/** Four CSV files as JSON text. Comfortably above the sample (~3 KB), far below Workers' own limit. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_LISTED_ROWS = 200;

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const history = /^\/api\/customers\/([^/]+)\/history$/.exec(pathname);
    const decision = /^\/api\/customers\/([^/]+)\/decisions$/.exec(pathname);
    const sampleFile = /^\/api\/sample\/([a-z_]+\.csv)$/.exec(pathname);
    try {
      if (request.method === "POST") {
        const refused = refuseUnsafePost(request, url);
        if (refused) return refused;
      }
      if (pathname === "/api/reconcile" && request.method === "POST") return await handleReconcile(request, env);
      if (history && request.method === "GET") return await handleHistory(safeDecode(history[1]!), env);
      if (decision && request.method === "POST") return await handleDecision(safeDecode(decision[1]!), request, env);
      if (pathname === "/api/demo/reset" && request.method === "POST") return await handleDemoReset(env);
      if (pathname === "/api/insights" && request.method === "GET") return await handleInsights(url.searchParams, env);
      if (pathname === "/api/insights/narrative" && request.method === "POST") return await handleNarrative(request, env);
      if (sampleFile && request.method === "GET") return sampleCsv(sampleFile[1]!);
      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof TooLarge) return json({ error: TOO_LARGE_MESSAGE }, 413);
      console.error(e);
      return json({ error: "Something went wrong on the server. Please try again." }, 500);
    }
  },
};

/**
 * Every state-changing request must be same-origin JSON. Requiring application/json forces a
 * CORS preflight that this API never approves, so another site cannot make a visitor's browser
 * record decisions, reset the demo or spend AI calls (CSRF). The Origin and Sec-Fetch-Site
 * checks refuse cross-site requests outright.
 */
function refuseUnsafePost(request: Request, url: URL): Response | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Cross-site requests are not allowed." }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ error: TOO_LARGE_MESSAGE }, 413);
  return null;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return ""; // fails the ID check and returns 400
  }
}

const ledger = (env: AppEnv, customerId: string) => env.LEDGER.get(env.LEDGER.idFromName(customerId) as never);

/**
 * Body: { "sample": true } for the demo, or { "files": { usage, invoices, plans?, creditMemos? } } with CSV text.
 * Plans and credit memos fall back to the sample files when not uploaded.
 */
async function handleReconcile(request: Request, env: AppEnv): Promise<Response> {
  const started = Date.now();
  const body = await readJson<{ sample?: boolean; files?: Partial<CsvFiles> }>(request);
  if (!body) return json({ error: "Request body must be JSON." }, 400);

  const uploaded = body.sample ? {} : (body.files ?? {});
  if (!body.sample && (!uploaded.usage || !uploaded.invoices)) {
    return json({ error: "Upload usage.csv and invoices.csv, or use the sample data." }, 400);
  }
  const files: CsvFiles = { ...SAMPLE, ...stripEmpty(uploaded) };
  const sources = Object.fromEntries(
    (Object.keys(SAMPLE) as (keyof CsvFiles)[]).map((k) => [k, uploaded[k] ? "uploaded" : "sample"]),
  );

  let result;
  try {
    result = reconcile(parseInputs(files));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }

  const warnings: string[] = [];
  const byCustomer = groupBy(result.findings, (f) => f.customerId);

  // Precedents come from each customer's ledger. A storage failure only drops the "seen before" line.
  const precedents: Record<string, Precedent> = {};
  await Promise.all(
    [...byCustomer].map(async ([customerId, findings]) => {
      try {
        const stub = ledger(env, customerId);
        if (body.sample && DEMO_HISTORY[customerId]) await stub.seed(DEMO_HISTORY[customerId]);
        Object.assign(precedents, await stub.precedents(findings.map(({ id, type, period }) => ({ id, type, period }))));
      } catch (e) {
        console.error(e);
        warnings.push(`History for ${customerId} could not be read.`);
      }
    }),
  );

  const explanations = await explainFindings(env.AI, result.findings, precedents);

  // Record each customer's findings; the ledger keeps any earlier analyst decision.
  const stored = new Map<string, Issue>();
  const now = new Date().toISOString();
  await Promise.all(
    [...byCustomer].map(async ([customerId, findings]) => {
      try {
        const issues = await ledger(env, customerId).record(
          findings.map((finding) => ({ finding, explanation: explanationText(explanations.get(finding.id)) })),
          now,
        );
        issues.forEach((i) => stored.set(i.key, i));
      } catch (e) {
        console.error(e);
        warnings.push(`Findings for ${customerId} could not be saved to history.`);
      }
    }),
  );

  return json({
    period: [...new Set(result.invoices.map((i) => i.period))],
    counts: result.counts,
    sources,
    ai: { model: MODEL, timeoutMs: AI_TIMEOUT_MS },
    warnings,
    // Rows that could not be read, and how the data was interpreted. Reasons never echo the rejected value.
    rejected: result.rejected.slice(0, MAX_LISTED_ROWS).map(({ line, reason }) => ({ line, reason })),
    rejectedCount: result.rejected.length,
    notices: result.notices.slice(0, MAX_LISTED_ROWS),
    noticeCount: result.notices.length,
    invoices: result.invoices.map((inv) => ({
      ...inv,
      plantedCase: body.sample ? (PLANTED_CASES[inv.invoiceId] ?? null) : null,
      findings: inv.findings.map((f) => {
        const issue = stored.get(f.id);
        return {
          ...f,
          label: ISSUE_NAMES[f.type],
          plantedCase: body.sample ? (PLANTED_CASES[f.invoiceId] ?? null) : null,
          ai: explanations.get(f.id),
          precedent: precedents[f.id] ?? null,
          status: issue?.status ?? (f.severity === "explained" ? "explained" : "open"),
          note: issue?.note ?? "",
          decidedBy: issue?.decidedBy ?? null,
          decidedAt: issue?.decidedAt ?? null,
        };
      }),
    })),
    durationMs: Date.now() - started,
  });
}

async function handleHistory(customerId: string, env: AppEnv): Promise<Response> {
  if (!CUSTOMER_ID.test(customerId)) return json({ error: "Invalid customer ID." }, 400);
  const { issues, events } = await ledger(env, customerId).history();
  return json({ customerId, issues: issues.map((i) => ({ ...i, label: ISSUE_NAMES[i.type] })), events });
}

/** Body: { issueKey, status: "resolved" | "escalated", note, analyst } */
async function handleDecision(customerId: string, request: Request, env: AppEnv): Promise<Response> {
  if (!CUSTOMER_ID.test(customerId)) return json({ error: "Invalid customer ID." }, 400);
  const body = await readJson<{ issueKey?: string; status?: Decision; note?: string; analyst?: string }>(request);
  if (!body?.issueKey || !body.status) return json({ error: "issueKey and status are required." }, 400);
  const out = await ledger(env, customerId).decide(
    body.issueKey,
    body.status,
    String(body.note ?? ""),
    String(body.analyst ?? ""),
    new Date().toISOString(),
  );
  return out.error ? json({ error: out.error }, 400) : json({ issue: out.issue });
}

const MAX_INSIGHT_CUSTOMERS = 500;

/** Read the named customers' ledgers and compute insights for `period`. Unreadable ledgers become warnings. */
async function loadInsights(customers: unknown, period: unknown, env: AppEnv) {
  if (typeof period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return { error: "period must look like 2026-10" };
  const ids = Array.isArray(customers) ? customers : [];
  if (!ids.length || ids.length > MAX_INSIGHT_CUSTOMERS || !ids.every((c) => typeof c === "string" && CUSTOMER_ID.test(c))) {
    return { error: `customers must be 1-${MAX_INSIGHT_CUSTOMERS} valid customer IDs` };
  }
  const warnings: string[] = [];
  const issues: InsightIssue[] = [];
  await Promise.all(
    [...new Set(ids as string[])].map(async (customerId) => {
      try {
        const { issues: own } = await ledger(env, customerId).history();
        issues.push(...own.map((i) => ({ ...i, customerId })));
      } catch (e) {
        console.error(e);
        warnings.push(`History for ${customerId} could not be read.`);
      }
    }),
  );
  return { insights: computeInsights(issues, period, new Date().toISOString()), warnings };
}

/** GET /api/insights?period=2026-10&customers=C001,C002 — metrics only, computed in code. */
async function handleInsights(params: URLSearchParams, env: AppEnv): Promise<Response> {
  const out = await loadInsights((params.get("customers") ?? "").split(",").filter(Boolean), params.get("period"), env);
  return "error" in out ? json({ error: out.error }, 400) : json(out);
}

/** POST { period, customers } — the same metrics, described in two or three sentences by the model. */
async function handleNarrative(request: Request, env: AppEnv): Promise<Response> {
  const body = await readJson<{ period?: unknown; customers?: unknown }>(request);
  if (!body) return json({ error: "Request body must be JSON." }, 400);
  const out = await loadInsights(body.customers, body.period, env);
  if ("error" in out) return json({ error: out.error }, 400);
  if (!out.insights.issues) return json({ narrative: { status: "ok", text: out.insights.summary } });
  return json({ narrative: await narrateInsights(env.AI, insightFacts(out.insights)) });
}

/** Clears the sample customers' ledgers and restores the seeded history, so every reviewer can start fresh. */
async function handleDemoReset(env: AppEnv): Promise<Response> {
  await Promise.all(
    SAMPLE_CUSTOMERS.map(async (c) => {
      const stub = ledger(env, c);
      await stub.reset();
      if (DEMO_HISTORY[c]) await stub.seed(DEMO_HISTORY[c]);
    }),
  );
  return json({ reset: SAMPLE_CUSTOMERS });
}

const SAMPLE_FILES: Record<string, string> = {
  "usage.csv": sampleUsage,
  "plans.csv": samplePlans,
  "invoices.csv": sampleInvoices,
  "credit_memos.csv": sampleCreditMemos,
};

/** Lets reviewers download the exact files the demo uses. */
function sampleCsv(name: string): Response {
  const body = SAMPLE_FILES[name];
  if (!body) return json({ error: "Not found" }, 404);
  return new Response(body, {
    headers: { ...API_HEADERS, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
  });
}

function explanationText(e: Explanation | undefined): string | null {
  return e?.status === "ok" ? e.explanation : null;
}

function groupBy(findings: Finding[], key: (f: Finding) => string) {
  const out = new Map<string, Finding[]>();
  for (const f of findings) out.set(key(f), [...(out.get(key(f)) ?? []), f]);
  return out;
}

/** Keep only the four known files, and only non-empty strings. */
function stripEmpty(files: Partial<CsvFiles>): Partial<CsvFiles> {
  const keys: (keyof CsvFiles)[] = ["usage", "plans", "invoices", "creditMemos"];
  return Object.fromEntries(
    keys.filter((k) => typeof files[k] === "string" && files[k]!.trim() !== "").map((k) => [k, files[k]]),
  );
}

const TOO_LARGE_MESSAGE =
  "The files together are larger than 5 MB, the limit for one check. Split the usage export by customer or by week, or summarize it to daily totals per customer.";
class TooLarge extends Error {}

/** Parse a JSON object body, enforcing the size limit even when Content-Length is absent. */
async function readJson<T>(request: Request): Promise<T | undefined> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new TooLarge();
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as T) : undefined;
  } catch {
    return undefined;
  }
}

/** API responses are data only: never rendered, framed, sniffed or cached. */
const API_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, "content-type": "application/json; charset=utf-8" } });
