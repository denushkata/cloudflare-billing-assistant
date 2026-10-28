// Coordination lives here and in the per-customer Durable Objects:
//   parse -> calculate -> look up precedents (per customer) -> explain each finding (in parallel)
//   -> record to each customer's ledger -> respond.
// Calculation never depends on the AI or storage steps; if either fails, results still return.

import sampleCreditMemos from "../sample-data/credit_memos.csv";
import sampleInvoices from "../sample-data/invoices.csv";
import samplePlans from "../sample-data/plans.csv";
import sampleUsage from "../sample-data/usage.csv";
import { AI_TIMEOUT_MS, explainFindings, ISSUE_NAMES, MODEL, type AiRunner, type Explanation } from "./ai";
import { DEMO_HISTORY } from "./demo";
import type { Decision, Issue, Ledger, Precedent } from "./ledger";
import { parseInputs, type CsvFiles } from "./recon/model";
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
const CUSTOMER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    const history = /^\/api\/customers\/([^/]+)\/history$/.exec(pathname);
    const decision = /^\/api\/customers\/([^/]+)\/decisions$/.exec(pathname);
    const sampleFile = /^\/api\/sample\/([a-z_]+\.csv)$/.exec(pathname);
    try {
      if (pathname === "/api/reconcile" && request.method === "POST") return await handleReconcile(request, env);
      if (history && request.method === "GET") return await handleHistory(decodeURIComponent(history[1]!), env);
      if (decision && request.method === "POST") return await handleDecision(decodeURIComponent(decision[1]!), request, env);
      if (pathname === "/api/demo/reset" && request.method === "POST") return await handleDemoReset(env);
      if (sampleFile && request.method === "GET") return sampleCsv(sampleFile[1]!);
      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "Something went wrong on the server. Please try again." }, 500);
    }
  },
};

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
    invoices: result.invoices.map((inv) => ({
      ...inv,
      findings: inv.findings.map((f) => {
        const issue = stored.get(f.id);
        return {
          ...f,
          label: ISSUE_NAMES[f.type],
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
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
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

function stripEmpty(files: Partial<CsvFiles>): Partial<CsvFiles> {
  return Object.fromEntries(Object.entries(files).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
}

async function readJson<T>(request: Request): Promise<T | undefined> {
  try {
    return (await request.json()) as T;
  } catch {
    return undefined;
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
