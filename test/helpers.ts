import { DatabaseSync } from "node:sqlite";
import type { AppEnv } from "../src/index";
import { Ledger, LedgerError, type Sql } from "../src/ledger";
import { Session } from "../src/session";

/** node:sqlite behind the same `exec(...).toArray()` shape as a Durable Object's ctx.storage.sql. */
export function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings) as Record<string, string | number | null>[];
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
}

/** One in-memory review session per session ID, like the ReviewSession namespace. */
export function fakeSessions(): AppEnv["SESSION"] & { sessions: Map<string, Session> } {
  const sessions = new Map<string, Session>();
  return {
    sessions,
    idFromName: (name) => name,
    get: (name) => {
      const key = name as unknown as string;
      if (!sessions.has(key)) sessions.set(key, new Session(memorySql()));
      const s = sessions.get(key)!;
      return {
        start: (meta, findings) => s.start(meta, findings),
        context: (recent) => {
          const meta = s.meta();
          return meta ? { meta, findings: s.findings(), recent: s.messages(recent), questions: s.questionCount() } : null;
        },
        messages: () => s.messages(),
        append: (m) => s.append(m),
      };
    },
  };
}

/** One in-memory ledger per customer name, like idFromName -> get on a Durable Object namespace. */
export function fakeLedgers(): AppEnv["LEDGER"] & { ledgers: Map<string, Ledger> } {
  const ledgers = new Map<string, Ledger>();
  return {
    ledgers,
    idFromName: (name) => name,
    get: (name) => {
      const key = name as unknown as string;
      if (!ledgers.has(key)) ledgers.set(key, new Ledger(memorySql()));
      const l = ledgers.get(key)!;
      return {
        precedents: (f) => l.precedents(f),
        record: (items, now) => l.record(items, now),
        history: () => l.history(),
        seed: (issues) => l.seed(issues),
        reset: () => l.reset(),
        decide: (...a) => {
          try {
            return { issue: l.decide(...a) };
          } catch (e) {
            if (e instanceof LedgerError) return { error: e.message };
            throw e;
          }
        },
      };
    },
  };
}
