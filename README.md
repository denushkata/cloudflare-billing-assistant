# Billing Reconciliation Assistant

A small AI-powered app on Cloudflare that checks whether customer invoices match actual usage and plan terms. It explains each mismatch in plain English and keeps a lasting history of issues and decisions for each customer.

Built for the Cloudflare optional assignment (Senior Director of Engineering, Billing Platform).

**Live demo:** https://billing-reconciliation-assistant.denitza-krasteva.workers.dev. Click **Load sample data**. No files or sign-in are needed.

## Design principle: code calculates, AI explains

All financial math is deterministic code. The model never computes an amount. It receives each finding with every number already calculated and formatted. It then writes an explanation, a likely cause and a suggested fix.

- **Money is exact.**
  - Amounts are integer cents, rates are integer nano-dollars per unit, and discounts are basis points.
  - Values are parsed from strings without floating point.
  - Rounding is half away from zero, once per line.
- **The model's reply is checked against the facts.** A reply is discarded if it contains:
  - a dollar amount or percentage that is not in the facts,
  - a link,
  - hidden characters.

  The calculated result is shown instead.
- **The app works without the AI.** If Workers AI errors, times out or has used its daily allowance, every card still shows its calculated result, with a short "explanation unavailable" note. The demo never depends on the model responding.
- **AI suggests, a person decides.** Nothing changes an issue's status except an analyst clicking **Resolve** or **Escalate** with a note.

## How it meets the assignment

| Requirement | Cloudflare component | Role in the app |
|---|---|---|
| LLM | Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Explains each finding, suggests a likely cause and a fix, answers the analyst's questions, and writes the insights summary |
| Workflow / coordination | Worker pipeline plus Durable Objects | Load data → calculate → look up each customer's history → explain findings in parallel → save to each customer's ledger and to the check's review session |
| User input (chat) | Chat panel, served by the Worker as a static asset | The analyst asks questions in plain English, such as "Why was this flagged?" or "Has C004 had this issue before?" Also on the page: the demo button, CSV upload, and Resolve and Escalate with notes |
| Memory / state | Durable Objects (SQLite): one per customer, one per check | Per customer: issue history, status, analyst notes and an append-only audit trail. Per check: the calculated results and the chat history |

### Coordination

The Worker coordinates each check in [src/index.ts](src/index.ts):

1. It parses and reconciles the files.
2. It asks each affected customer's Durable Object for matching past issues.
3. It sends up to 50 explanation calls to Workers AI in parallel, each with a 10-second timeout.
4. It records the results to each customer's ledger.

Calculation never waits on the AI or on storage. If either fails, the results still return.

Durable Objects provide the per-customer coordination. Each customer's ledger is a single object, so decisions on one customer are applied one at a time. For example, when two tabs resolve and escalate the same issue at once, one wins and the other is refused.

### Persistence

Each customer has a Durable Object with its own SQLite database ([src/ledger.ts](src/ledger.ts)). It holds:
- each issue's type, amounts, status (open, escalated or resolved), analyst note, and who decided and when;
- an audit trail of events. Database triggers keep it append-only and make a resolution final.

When a new finding matches a past decided issue for the same customer, the model gets that one precedent and adds a suggestion line. In the demo, C004's wrong-state sales tax was resolved in September and recurs in October. Its card reads, for example: "Same wrong-state sales tax in September 2026, resolved with a credit… It has recurred despite that fix."

### Chat

Below the results, the analyst can ask about them in plain English. Each card also has an **Ask** button that scopes the question to that finding. Suggested questions are built from the current results.

How a question is answered ([src/chat.ts](src/chat.ts)):

1. **The context is built in code, on the server.** When a check runs, the Worker stores its calculated results in a new `ReviewSession` Durable Object ([src/session.ts](src/session.ts)). After that, the page sends only the question and the session ID, so a modified page can't feed the model its own "results".
2. **History comes from the ledgers.** For a question about a customer (named, by invoice ID, from a card, or a follow-up to the previous question), the Worker reads that customer's ledger. The model then sees decisions made after the check, and the customer's issues from earlier months.
3. **File text and notes are kept apart.** CSV text goes in under `quoted_from_files` and analyst notes under `analyst_notes`. The prompt marks both as data, never instructions.
4. **The reply is checked.** Every number in the answer, and in its "not in the results" note, must appear in the calculated context. A number that appears only in quoted text, a note, or the question itself doesn't count. Links and hidden characters are refused. The model's list of findings it relied on is checked against the context, and each one shows as a link to its card.
5. **Questions that need new figures get an honest answer.** For example, "What would the total be if we waived all overage?" gets "that total is not in the calculated results". If the model computes a figure anyway, the reply is discarded, and the analyst sees "the answer used a number the code did not calculate".

Questions and answers are stored in the session's Durable Object, append-only. A session deletes itself a week after its check, while decisions stay in the customers' ledgers. Each check allows up to 40 questions of up to 500 characters, and the last three exchanges go along as conversation context.

## Design choices

- **Workers with static assets, not Pages.** This is Cloudflare's current guidance for new projects. One Worker serves both the page and the API.
- **A plain Worker pipeline, not Workflows.** A synchronous request keeps the demo button fast and impossible to leave hanging. Workflows is the next step for large batch or scheduled runs (see [Next steps](#next-steps)).
- **Credit memos as separate records.** This mirrors Stripe credit notes, Zuora credit memos and ERP credit ledgers. A credit on an invoice is *explained* when it cites an approved memo for the same customer, period and amount, and no other invoice has used that memo. Otherwise it is flagged.
- **One root cause, one finding.** Each check measures its component against the invoice's own other lines. So a missing discount is not also reported as a tax error.
- **A customer's invoices for a period are checked together.** That catches a charge billed on two invoices, or a memo used twice. Each finding is filed on the invoice that holds the line in question.
- **Never "clean" on partial data.** An unreadable row is listed with its file, line and reason, and the rest of the file is still checked. A customer with a rejected plan, usage or invoice row is marked *not checked* rather than reported clean.
- **The billing time zone is America/New_York.** Usage is assigned to the month it falls in on the New York calendar, not the UTC calendar. Usage at 11:30 PM Eastern on October 31 is October usage, even though it is November in UTC.
- **Plain JavaScript on the page, no framework.** It is a single page with a small DOM helper that never uses `innerHTML`.

## Run it locally

Requirements:
- Node.js 22 or later. The tests use the built-in `node:sqlite` in place of Durable Object storage.
- To run the app (not the tests), a free Cloudflare account with a `workers.dev` subdomain. Workers AI has no local emulator, so `wrangler dev` connects to the real model and needs you signed in.

```bash
npm install
```

```bash
npm test
```

The tests cover reconciliation, the AI guardrails, persistence, security, insights and the full `test-data/` suite. None of them need a Cloudflare account.

```bash
npx wrangler login
```

```bash
npm run dev
```

Open http://localhost:8787 and click **Load sample data**.

- **If the AI is unavailable**, each card says "explanation unavailable" and everything else works.
- **Durable Objects run locally**, so history persists between runs. **Reset demo history** restores the starting state.
- **Free daily allowance:** the free plan includes 10,000 Workers AI neurons a day. A day of heavy testing can use it up. The page then says "the Workers AI daily allowance is used up (it resets at 00:00 UTC)". The Workers Paid plan removes the daily cap.

To deploy:

```bash
npm run deploy
```

This needs a `workers.dev` subdomain on the account.

## Sample data and planted cases

The demo uses the four files in [sample-data/](sample-data/): 10 customers in October 2026. You can download them from the page.

| # | Planted case | Finding |
|---|---|---|
| 1 | Mid-month upgrade billed at the old price for the full month | Proration error, −$154.84 |
| 2 | Overage charged on total usage instead of usage above the included amount | Overage on total, +$500.00 |
| 3 | 15% contract discount not applied | Missing discount, +$75.00 |
| 4 | Washington customer taxed at the California rate | Wrong-state tax, +$4.11, a repeat of a September issue |
| 5 | Duplicate overage line | Duplicate line, +$31.80 |
| 6 | Usage at 11:30 PM Eastern on Oct 31 left off October because it was sorted into months by UTC | Time zone period error, −$20.00 |
| 7 | Invoice $50 lower because of an approved SLA credit memo | **Explained, not flagged** |
| 8 | Three clean invoices | No findings |

[docs/expected-results.md](docs/expected-results.md) has every expected value and the calculation rules. The unit tests assert each one.

## Testing

- **`npm test`** runs the unit tests (about 210) in a few seconds.
- **[test-data/](test-data/)** is a separate suite of 26 CSV files:
  - 30 functional edge cases;
  - malformed files;
  - security attacks: XSS, formula injection, prompt injection, hostile customer IDs, CSV row injection and oversized fields;
  - stress sets: 500 exceptions at once, and a 7.4 MB usage file.

  [test/test-data.test.ts](test/test-data.test.ts) uploads every set through the API, and [test-data/RESULTS.md](test-data/RESULTS.md) records the result for each case.

  The 7.4 MB usage file is not committed. Recreate it with:

  ```bash
  node test-data/4-stress/large_usage/generate-usage.mjs
  ```
- **On the deployed Worker**, the functional, security and 500-exception sets give the same results as locally. The 500-exception set takes about 14 seconds, and insights across those 500 customers about 25 seconds. That is the reason for the aggregate store in next steps.
- **Browser checks** were done against `wrangler dev` and the live site, with real Durable Objects and real Workers AI:
  - the demo flow;
  - light and dark themes, and phone widths;
  - the security set, with `alert` trapped to confirm nothing executes.

## Security

- **Uploaded and typed text is checked.** CSV fields, notes and names are refused if they contain:
  - links, email addresses, HTML or markdown links;
  - bidirectional overrides, zero-width or control characters.

  IDs must be plain identifiers, because they become storage keys. A rejected value is listed as visible, length-limited text.
- **Everything renders as text.** The page never uses `innerHTML`. Untrusted text appears only as plain text, including text copied from files and model output.
- **Prompt injection.** Text copied from files and past analyst notes reaches the model under labels that the prompt marks as data, not instructions. This applies to explanations, the insights summary and chat. Amounts that appear only there are not trusted when the reply is checked. The chat tests replay the P01, P02 and P04 cases from `test-data/3-security`, and no answer can change an issue's status.
- **CSRF.** Every POST must be same-origin `application/json`; cross-site requests get a 403.
- **Headers.** A strict Content Security Policy, `nosniff`, `no-referrer` and `no-store` on API responses.
- **Limits:**
  - 5 MB and 20,000 rows per file in one check;
  - 50 AI calls per check, 10 seconds each;
  - 40 chat questions per check, 500 characters each;
  - 1,000 characters per note.
- **Audit trail.** Events are append-only and resolutions are final, both enforced in the database.

## Insights

Above the issue list, a panel shows metrics computed in code:
- exposure, split into overcharged and undercharged and by status;
- root causes ranked by dollars;
- aging of open and escalated issues;
- how often issues recur;
- customer hotspots.

It also has a short AI summary. Every number in that summary must appear in the computed metrics, or the code-written summary is shown instead.

## Project layout

| Path | What it is |
|---|---|
| [src/recon/](src/recon/) | Deterministic reconciliation: CSV parsing, money, periods, tax table, checks |
| [src/ai.ts](src/ai.ts) | Prompts, parallel calls, timeouts and reply checks |
| [src/ledger.ts](src/ledger.ts), [src/customer-do.ts](src/customer-do.ts) | Per-customer persistence in a Durable Object |
| [src/chat.ts](src/chat.ts), [src/session.ts](src/session.ts), [src/session-do.ts](src/session-do.ts) | Chat: context built in code, reply checks, and the per-check session Durable Object |
| [src/insights.ts](src/insights.ts) | Exposure, aging, recurrence and hotspot metrics |
| [src/index.ts](src/index.ts) | API routes and the coordination pipeline |
| [src/safety.ts](src/safety.ts) | Input and output text rules |
| [public/](public/) | The page, styles and security headers |
| [sample-data/](sample-data/), [docs/](docs/) | Demo files and expected results |
| [test/](test/), [test-data/](test-data/) | Unit tests and the edge-case suite |

## Next steps

Out of scope for this version, roughly in priority order:

1. **Direct integration with billing systems and usage pipelines.** Read usage, invoices and credit memos from the billing system and the usage pipeline instead of CSV exports. Run on a schedule, not on upload.
2. **Workflows for large batch or scheduled runs.**
   - Durable, retryable steps would replace the single request.
   - That lifts the 5 MB / 20,000-row limit.
   - It also spreads AI calls past the per-check cap of 50, and handles Workers AI rate limits with retries.
3. **Payments reconciliation.** Match cash received against invoices, alongside invoices against usage.
4. **Authentication and roles with Cloudflare Access.**
   - A verified identity replaces the typed analyst name.
   - Then separation of duties: whoever escalated an issue cannot also resolve it. The ledger already records who escalated, so this is one check.
5. **Per-user settings** kept separate from the customer ledgers: checklist progress and saved filters.
6. **More months of data for month-over-month anomalies.** This needs two or three more months of sample data and an updated expected-results table. After that, per-analyst metrics (workload, time to resolve), once identity is verified.
7. **Customer names.** Map customer IDs to names, for example a `customer_name` column.
8. **A production store for insights.** Use D1 or Workers Analytics Engine, updated on each write, instead of reading every customer's Durable Object.
9. **A real tax engine.** The state tax table is illustrative and exists only to make the demo deterministic.
10. **Smaller items:**
    - voice input for the chat panel using the browser's built-in speech recognition;
    - rate limiting per user;
    - safe ticket links on an allowlisted domain;
    - if a CSV export is added, neutralize cells that start with `=`, `+`, `-` or `@`.
