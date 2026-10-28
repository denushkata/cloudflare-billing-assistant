// Workers AI writes the words; it never computes. Each finding arrives with its
// amounts already calculated and formatted, and any dollar amount or percentage in
// the reply that was not in the facts causes the reply to be discarded.

import { formatCents } from "./recon/money";
import type { Finding } from "./recon/reconcile";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const AI_TIMEOUT_MS = 8_000;

export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export type Explanation =
  | { status: "ok"; explanation: string; likelyCause: string; suggestedFix: string }
  | { status: "unavailable"; note: string };

const SYSTEM_PROMPT = `You help billing analysts review invoice reconciliation findings.
Deterministic code has already calculated every amount, and those amounts are correct.
Rules:
- Never calculate, estimate, round or convert anything. Do not introduce any dollar amount or percentage that is not in the facts; you may repeat amounts exactly as given.
- Write for a finance analyst: plain English, specific, no filler.
- "explanation": at most two sentences on what happened on this invoice.
- "likely_cause": one sentence on the most plausible upstream cause in the billing or usage pipeline.
- "suggested_fix": one sentence on what the analyst should do for this customer now.
- If severity is "explained", the invoice is correct: explain why it looks different and suggest no correction.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    explanation: { type: "string" },
    likely_cause: { type: "string" },
    suggested_fix: { type: "string" },
  },
  required: ["explanation", "likely_cause", "suggested_fix"],
};

/** Explain all findings in parallel. Never throws; a failed or slow call yields "unavailable". */
export async function explainFindings(
  ai: AiRunner,
  findings: Finding[],
  timeoutMs = AI_TIMEOUT_MS,
): Promise<Map<string, Explanation>> {
  const results = await Promise.all(findings.map((f) => explainOne(ai, f, timeoutMs)));
  return new Map(findings.map((f, i) => [f.id, results[i]!]));
}

async function explainOne(ai: AiRunner, finding: Finding, timeoutMs: number): Promise<Explanation> {
  const facts = promptFacts(finding);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    const reply = await Promise.race([
      ai.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(facts, null, 2) },
        ],
        response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
        max_tokens: 300,
        temperature: 0.2,
      }),
      timeout,
    ]);
    const parsed = parseReply(reply);
    if (!parsed) return unavailable("the model returned an unreadable reply");
    const invented = inventedAmounts(Object.values(parsed).join(" "), JSON.stringify(facts));
    if (invented.length) return unavailable(`the model introduced amounts not in the facts (${invented.join(", ")})`);
    return { status: "ok", explanation: parsed.explanation, likelyCause: parsed.likely_cause, suggestedFix: parsed.suggested_fix };
  } catch (e) {
    const msg = (e as Error).message;
    return unavailable(msg === "timeout" ? `no reply within ${timeoutMs / 1000}s` : "the AI service returned an error");
  } finally {
    clearTimeout(timer);
  }
}

/** Everything the model sees. Money is pre-formatted; the model has nothing to compute. */
export function promptFacts(f: Finding) {
  return {
    finding_type: f.type,
    severity: f.severity,
    customer_id: f.customerId,
    invoice_id: f.invoiceId,
    period: f.period,
    expected: formatCents(f.expectedCents),
    invoiced: formatCents(f.invoicedCents),
    difference: formatCents(f.differenceCents),
    direction: f.differenceCents > 0 ? "customer overcharged" : f.differenceCents < 0 ? "customer undercharged" : "no net difference",
    calculated_summary: f.summary,
    details: f.facts,
  };
}

function parseReply(reply: unknown): { explanation: string; likely_cause: string; suggested_fix: string } | undefined {
  let body = (reply as { response?: unknown })?.response;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  const b = body as Record<string, unknown> | undefined;
  const ok = (k: string) => typeof b?.[k] === "string" && (b[k] as string).trim().length > 0;
  if (!ok("explanation") || !ok("likely_cause") || !ok("suggested_fix")) return undefined;
  return {
    explanation: (b!.explanation as string).trim(),
    likely_cause: (b!.likely_cause as string).trim(),
    suggested_fix: (b!.suggested_fix as string).trim(),
  };
}

/** Dollar amounts and percentages in `text` that do not appear in `facts`. Sign and "$" placement are ignored. */
export function inventedAmounts(text: string, facts: string): string[] {
  const norm = (s: string) => s.replace(/[$,\s-]/g, "").replace(/\.00$/, "");
  const pattern = /-?\$\s?-?[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?\s?%/g;
  const allowed = new Set((facts.match(pattern) ?? []).map(norm));
  return [...new Set((text.match(pattern) ?? []).filter((m) => !allowed.has(norm(m))))];
}

const unavailable = (reason: string): Explanation => ({ status: "unavailable", note: `Explanation unavailable: ${reason}.` });
