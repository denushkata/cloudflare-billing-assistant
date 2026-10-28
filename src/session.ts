// One review session per reconciliation check: a snapshot of that check's calculated
// results and the analyst's chat about them. The snapshot is written once, by the Worker,
// when the check runs; the browser only ever sends a question. So everything the chat
// model sees as "results" was produced by code, never supplied by the page.
// Runs on any SQLite with an `exec` method, like the ledger.

import type { Sql } from "./ledger";
import type { Finding } from "./recon/reconcile";

/** A finding as it stood when the check ran, with its label and review status at that time. */
export type SessionFinding = Pick<
  Finding,
  "id" | "customerId" | "invoiceId" | "period" | "type" | "severity" | "expectedCents" | "invoicedCents" | "differenceCents" | "summary" | "facts" | "quoted"
> & { label: string; status: string };

export interface SessionMeta {
  createdAt: string;
  periods: string[];
  counts: { invoices: number; clean: number; explained: number; flagged: number };
  /** Every customer in the check, including clean ones, so a question can name any of them. */
  customers: string[];
}

export interface ChatMessage {
  id: number;
  at: string;
  role: "analyst" | "assistant";
  /** The analyst's name, or the model for an answer. */
  author: string;
  text: string;
  /** For an answer: what the model said it could not find in the results. */
  missing: string;
  /** For an answer: finding IDs it relied on, each checked to exist in its context. */
  cited: string[];
  /** Customers the question was about, so a follow-up such as "has this happened before?" keeps them. */
  customers: string[];
  focus: string | null;
  status: "ok" | "unavailable";
}

export type NewMessage = Omit<ChatMessage, "id">;

export const MAX_QUESTIONS_PER_SESSION = 40;
export const MAX_QUESTION_LENGTH = 500;
/** Sessions are working state, not the audit record (decisions live in each customer's ledger). */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class Session {
  constructor(private sql: Sql) {
    sql.exec("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, invoice_id TEXT NOT NULL, json TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, role TEXT NOT NULL, author TEXT NOT NULL,
      text TEXT NOT NULL, missing TEXT NOT NULL DEFAULT '', cited TEXT NOT NULL DEFAULT '[]',
      customers TEXT NOT NULL DEFAULT '[]', focus TEXT, status TEXT NOT NULL)`);
    // The snapshot and the conversation are records of what was shown: neither can be edited.
    sql.exec(`CREATE TRIGGER IF NOT EXISTS findings_fixed BEFORE UPDATE ON findings
      BEGIN SELECT RAISE(ABORT, 'session results are fixed'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_append_only BEFORE UPDATE ON messages
      BEGIN SELECT RAISE(ABORT, 'chat messages are append-only'); END`);
  }

  /** Store the check's results. Written once; a second call is refused so results cannot be swapped under a conversation. */
  start(meta: SessionMeta, findings: SessionFinding[]): void {
    if (this.meta()) throw new Error("session already started");
    this.sql.exec("INSERT INTO meta (id, json) VALUES (1, ?)", JSON.stringify(meta));
    for (const f of findings) {
      this.sql.exec("INSERT INTO findings (id, customer_id, invoice_id, json) VALUES (?, ?, ?, ?)", f.id, f.customerId, f.invoiceId, JSON.stringify(f));
    }
  }

  meta(): SessionMeta | undefined {
    const row = this.sql.exec("SELECT json FROM meta WHERE id = 1").toArray()[0];
    return row ? (JSON.parse(String(row.json)) as SessionMeta) : undefined;
  }

  findings(): SessionFinding[] {
    return this.sql.exec("SELECT json FROM findings ORDER BY rowid").toArray().map((r) => JSON.parse(String(r.json)) as SessionFinding);
  }

  messages(limit = 200): ChatMessage[] {
    return this.sql
      .exec("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id", limit)
      .toArray()
      .map((r) => ({
        id: Number(r.id),
        at: String(r.at),
        role: r.role as ChatMessage["role"],
        author: String(r.author),
        text: String(r.text),
        missing: String(r.missing),
        cited: JSON.parse(String(r.cited)) as string[],
        customers: JSON.parse(String(r.customers)) as string[],
        focus: r.focus === null ? null : String(r.focus),
        status: r.status as ChatMessage["status"],
      }));
  }

  questionCount(): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE role = 'analyst'").toArray()[0]!.n);
  }

  append(messages: NewMessage[]): ChatMessage[] {
    for (const m of messages) {
      this.sql.exec(
        "INSERT INTO messages (at, role, author, text, missing, cited, customers, focus, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        m.at, m.role, m.author, m.text, m.missing, JSON.stringify(m.cited), JSON.stringify(m.customers), m.focus, m.status,
      );
    }
    return this.messages(messages.length);
  }
}
