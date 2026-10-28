// One Durable Object per reconciliation check (addressed by a random session ID): the check's
// calculated results and the analyst's chat about them, in its own SQLite database.
// It deletes itself a week after the check; decisions are kept in the customers' ledgers.

import { DurableObject } from "cloudflare:workers";
import { Session, SESSION_TTL_MS, type NewMessage, type SessionFinding, type SessionMeta } from "./session";

export class ReviewSession extends DurableObject {
  private session: Session;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.session = new Session(ctx.storage.sql);
  }

  async start(meta: SessionMeta, findings: SessionFinding[]) {
    this.session.start(meta, findings);
    await this.ctx.storage.setAlarm(Date.now() + SESSION_TTL_MS);
  }

  /** Everything a question needs, in one round trip. */
  context(recent: number) {
    const meta = this.session.meta();
    if (!meta) return null;
    return { meta, findings: this.session.findings(), recent: this.session.messages(recent), questions: this.session.questionCount() };
  }

  messages() {
    return this.session.messages();
  }

  append(messages: NewMessage[]) {
    return this.session.append(messages);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
