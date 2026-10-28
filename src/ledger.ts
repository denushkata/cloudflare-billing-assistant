// Per-customer issue ledger: every finding, its current status, and an append-only
// audit trail of who decided what and when. Runs on any SQLite with an `exec` method:
// a Durable Object's ctx.storage.sql in production, node:sqlite in tests.

import { formatCents } from "./recon/money";
import type { Finding, FindingType, Severity } from "./recon/reconcile";
import { safeAnalystName, safeText, SafetyError } from "./safety";

type SqlValue = string | number | null;
export interface Sql {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] };
}

export type IssueStatus = "open" | "resolved" | "escalated" | "explained";
export type Decision = "resolved" | "escalated";

export interface Issue {
  key: string;
  invoiceId: string;
  period: string;
  type: FindingType;
  severity: Severity;
  expectedCents: number;
  invoicedCents: number;
  differenceCents: number;
  summary: string;
  explanation: string | null;
  status: IssueStatus;
  note: string;
  decidedBy: string | null;
  decidedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AuditEvent {
  issueKey: string;
  at: string;
  actor: string;
  action: "detected" | "seeded" | Decision;
  note: string;
}

/** A decided issue of the same type from an earlier period, chosen by code, not by the model. */
export interface Precedent {
  issueKey: string;
  invoiceId: string;
  period: string;
  type: FindingType;
  status: Decision;
  note: string;
  decidedBy: string;
  decidedAt: string;
  differenceCents: number;
  /** Deterministic line shown when the AI suggestion is unavailable. */
  summary: string;
}

export interface FindingToRecord {
  finding: Finding;
  explanation: string | null;
}

export type SeedIssue = Omit<Issue, "lastSeenAt" | "explanation">;

export const MAX_NOTE_LENGTH = 1000;

export class Ledger {
  constructor(private sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS issues (
      key TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, period TEXT NOT NULL, type TEXT NOT NULL,
      severity TEXT NOT NULL, expected_cents INTEGER NOT NULL, invoiced_cents INTEGER NOT NULL,
      difference_cents INTEGER NOT NULL, summary TEXT NOT NULL, explanation TEXT,
      status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', decided_by TEXT, decided_at TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, issue_key TEXT NOT NULL, at TEXT NOT NULL,
      actor TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '')`);
    // Defense in depth below the application code: audit events can never be edited, and
    // a resolved issue's decision can never change. (Rows are deleted only by the demo reset.)
    sql.exec(`CREATE TRIGGER IF NOT EXISTS events_append_only BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS resolved_is_final BEFORE UPDATE OF status, note, decided_by, decided_at ON issues
      WHEN OLD.status = 'resolved' BEGIN SELECT RAISE(ABORT, 'resolved issues are final'); END`);
  }

  /** For each finding, the most recent decided issue of the same type from an earlier period. */
  precedents(findings: Pick<Finding, "id" | "type" | "period">[]): Record<string, Precedent> {
    const out: Record<string, Precedent> = {};
    for (const f of findings) {
      const row = this.sql
        .exec(
          `SELECT * FROM issues WHERE type = ? AND period < ? AND status IN ('resolved', 'escalated')
           ORDER BY period DESC, decided_at DESC LIMIT 1`,
          f.type,
          f.period,
        )
        .toArray()[0];
      if (!row) continue;
      const i = toIssue(row);
      out[f.id] = {
        issueKey: i.key,
        invoiceId: i.invoiceId,
        period: i.period,
        type: i.type,
        status: i.status as Decision,
        note: i.note,
        decidedBy: i.decidedBy!,
        decidedAt: i.decidedAt!,
        differenceCents: i.differenceCents,
        summary: `Seen before in ${i.period} (${i.invoiceId}, ${formatCents(i.differenceCents)}): ${i.status} by ${i.decidedBy}${i.note ? `, note: "${i.note}"` : ""}.`,
      };
    }
    return out;
  }

  /**
   * Upsert findings from a reconciliation run. Re-running the same data refreshes the
   * amounts and explanation but never overwrites an analyst's decision.
   */
  record(items: FindingToRecord[], now: string): Issue[] {
    for (const { finding: f, explanation } of items) {
      const existing = this.sql.exec("SELECT key FROM issues WHERE key = ?", f.id).toArray().length > 0;
      if (existing) {
        this.sql.exec(
          `UPDATE issues SET expected_cents = ?, invoiced_cents = ?, difference_cents = ?, summary = ?,
           explanation = COALESCE(?, explanation), last_seen_at = ? WHERE key = ?`,
          f.expectedCents, f.invoicedCents, f.differenceCents, f.summary, explanation, now, f.id,
        );
        continue;
      }
      this.sql.exec(
        `INSERT INTO issues (key, invoice_id, period, type, severity, expected_cents, invoiced_cents,
         difference_cents, summary, explanation, status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        f.id, f.invoiceId, f.period, f.type, f.severity, f.expectedCents, f.invoicedCents,
        f.differenceCents, f.summary, explanation, f.severity === "explained" ? "explained" : "open", now, now,
      );
      this.event(f.id, now, "system", "detected", "");
    }
    return items.map(({ finding }) => this.issue(finding.id)!);
  }

  decide(key: string, status: Decision, note: string, analyst: string, now: string): Issue {
    if (status !== "resolved" && status !== "escalated") throw new LedgerError("status must be resolved or escalated");
    let name: string;
    let cleanNote: string;
    try {
      name = safeAnalystName(analyst);
      cleanNote = safeText(note, "note", { max: MAX_NOTE_LENGTH });
    } catch (e) {
      if (e instanceof SafetyError) throw new LedgerError(e.message);
      throw e;
    }
    if (typeof key !== "string" || key.length > 200) throw new LedgerError("invalid issue key");
    const issue = this.issue(key);
    if (!issue) throw new LedgerError(`no issue ${key} for this customer`);
    if (issue.status === "explained") throw new LedgerError("explained items are correct and need no decision");
    // open -> resolved | escalated, escalated -> resolved. A resolution is final: it is the audit record.
    if (issue.status === "resolved") throw new LedgerError(`already resolved by ${issue.decidedBy}; resolutions are final`);
    if (issue.status === "escalated" && status === "escalated") throw new LedgerError(`already escalated by ${issue.decidedBy}`);
    if (!cleanNote) throw new LedgerError(`a note is required to mark an issue ${status}`);
    this.sql.exec(
      "UPDATE issues SET status = ?, note = ?, decided_by = ?, decided_at = ? WHERE key = ?",
      status, cleanNote, name, now, key,
    );
    this.event(key, now, name, status, cleanNote);
    return this.issue(key)!;
  }

  history(): { issues: Issue[]; events: AuditEvent[] } {
    return {
      issues: this.sql.exec("SELECT * FROM issues ORDER BY period DESC, invoice_id, key").toArray().map(toIssue),
      events: this.sql
        .exec("SELECT issue_key, at, actor, action, note FROM events ORDER BY at DESC, id DESC")
        .toArray()
        .map((r) => ({
          issueKey: String(r.issue_key),
          at: String(r.at),
          actor: String(r.actor),
          action: r.action as AuditEvent["action"],
          note: String(r.note),
        })),
    };
  }

  /** Insert past issues for the demo. Idempotent: existing keys are left alone. */
  seed(issues: SeedIssue[]): void {
    for (const i of issues) {
      if (this.issue(i.key)) continue;
      this.sql.exec(
        `INSERT INTO issues (key, invoice_id, period, type, severity, expected_cents, invoiced_cents,
         difference_cents, summary, explanation, status, note, decided_by, decided_at, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        i.key, i.invoiceId, i.period, i.type, i.severity, i.expectedCents, i.invoicedCents, i.differenceCents,
        i.summary, i.status, i.note, i.decidedBy, i.decidedAt, i.firstSeenAt, i.firstSeenAt,
      );
      this.event(i.key, i.firstSeenAt, "system", "seeded", "");
      if (i.decidedAt && i.decidedBy && (i.status === "resolved" || i.status === "escalated")) {
        this.event(i.key, i.decidedAt, i.decidedBy, i.status, i.note);
      }
    }
  }

  reset(): void {
    this.sql.exec("DELETE FROM issues");
    this.sql.exec("DELETE FROM events");
  }

  private issue(key: string): Issue | undefined {
    const row = this.sql.exec("SELECT * FROM issues WHERE key = ?", key).toArray()[0];
    return row ? toIssue(row) : undefined;
  }

  private event(key: string, at: string, actor: string, action: AuditEvent["action"], note: string) {
    this.sql.exec("INSERT INTO events (issue_key, at, actor, action, note) VALUES (?, ?, ?, ?, ?)", key, at, actor, action, note);
  }
}

/** A request the ledger refuses; the Worker returns it as a 400. */
export class LedgerError extends Error {}

function toIssue(r: Record<string, SqlValue>): Issue {
  return {
    key: String(r.key),
    invoiceId: String(r.invoice_id),
    period: String(r.period),
    type: r.type as FindingType,
    severity: r.severity as Severity,
    expectedCents: Number(r.expected_cents),
    invoicedCents: Number(r.invoiced_cents),
    differenceCents: Number(r.difference_cents),
    summary: String(r.summary),
    explanation: r.explanation === null ? null : String(r.explanation),
    status: r.status as IssueStatus,
    note: String(r.note ?? ""),
    decidedBy: r.decided_by === null ? null : String(r.decided_by),
    decidedAt: r.decided_at === null ? null : String(r.decided_at),
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
  };
}
