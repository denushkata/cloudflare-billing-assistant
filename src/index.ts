// Coordination: parse -> calculate -> explain each finding (in parallel) -> respond.
// Calculation never depends on the AI step; if Workers AI fails, results still return.

import sampleCreditMemos from "../sample-data/credit_memos.csv";
import sampleInvoices from "../sample-data/invoices.csv";
import samplePlans from "../sample-data/plans.csv";
import sampleUsage from "../sample-data/usage.csv";
import { AI_TIMEOUT_MS, explainFindings, MODEL, type AiRunner } from "./ai";
import { parseInputs, type CsvFiles } from "./recon/model";
import { reconcile } from "./recon/reconcile";

export interface AppEnv {
  AI: AiRunner;
}

const SAMPLE: CsvFiles = { usage: sampleUsage, plans: samplePlans, invoices: sampleInvoices, creditMemos: sampleCreditMemos };

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/reconcile" && request.method === "POST") return handleReconcile(request, env);
    return json({ error: "Not found" }, 404);
  },
};

/**
 * Body: { "sample": true } for the demo, or { "files": { usage, invoices, plans?, creditMemos? } } with CSV text.
 * Plans and credit memos fall back to the sample files when not uploaded.
 */
async function handleReconcile(request: Request, env: AppEnv): Promise<Response> {
  const started = Date.now();
  let body: { sample?: boolean; files?: Partial<CsvFiles> };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

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

  const explanations = await explainFindings(env.AI, result.findings);

  return json({
    period: [...new Set(result.invoices.map((i) => i.period))],
    counts: result.counts,
    sources,
    ai: { model: MODEL, timeoutMs: AI_TIMEOUT_MS },
    invoices: result.invoices.map((inv) => ({
      ...inv,
      findings: inv.findings.map((f) => ({ ...f, ai: explanations.get(f.id) })),
    })),
    durationMs: Date.now() - started,
  });
}

function stripEmpty(files: Partial<CsvFiles>): Partial<CsvFiles> {
  return Object.fromEntries(Object.entries(files).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
