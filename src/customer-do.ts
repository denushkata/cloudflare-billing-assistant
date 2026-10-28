// One Durable Object per customer (addressed by customer ID). It holds that customer's
// issue ledger in its own SQLite database, so each customer's history is strongly
// consistent and isolated from every other customer's.

import { DurableObject } from "cloudflare:workers";
import { Ledger, LedgerError, type Decision, type FindingToRecord, type SeedIssue } from "./ledger";
import type { Finding } from "./recon/reconcile";

export class CustomerLedger extends DurableObject {
  private ledger: Ledger;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.ledger = new Ledger(ctx.storage.sql);
  }

  precedents(findings: Pick<Finding, "id" | "type" | "period">[]) {
    return this.ledger.precedents(findings);
  }

  record(items: FindingToRecord[], now: string) {
    return this.ledger.record(items, now);
  }

  /** Errors cross the RPC boundary as plain messages, so return them as values. */
  decide(key: string, status: Decision, note: string, analyst: string, now: string) {
    try {
      return { issue: this.ledger.decide(key, status, note, analyst, now) };
    } catch (e) {
      if (e instanceof LedgerError) return { error: e.message };
      throw e;
    }
  }

  history() {
    return this.ledger.history();
  }

  seed(issues: SeedIssue[]) {
    this.ledger.seed(issues);
  }

  reset() {
    this.ledger.reset();
  }
}
