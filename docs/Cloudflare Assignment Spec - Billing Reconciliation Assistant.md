# Billing Reconciliation Assistant: Build Spec

Cloudflare optional assignment for Senior Director of Engineering, Billing Platform (job 8152825).

- **Written** 2026-10-27, and updated that day after the build plan review (Workers static assets, plain Worker pipeline, credit memos, AI fallback).
- **Updated 2026-10-28** after the build. It now covers insights, the test-data suite, the data rules it led to, the chat panel, and deployment.

Hand this file to Claude Code to build.

## Purpose

A small AI-powered app on Cloudflare that:
- checks whether customer invoices match actual usage and plan terms;
- explains each mismatch in plain English;
- answers an analyst's questions about the results;
- keeps a persistent history of issues and resolutions for each customer.

Design principle: **code calculates, AI explains.**
- All financial math is deterministic code. The LLM never computes amounts.
- It explains exceptions one at a time, suggests a likely cause and a fix, and answers questions from the calculated results.
- Any number in a model reply that the code did not calculate causes the reply to be discarded.

## Assignment requirements and how they're met

| Requirement | Cloudflare component | Role in the app |
|---|---|---|
| LLM | Workers AI (Llama 3.3 70B) | Writes plain-English explanations, the likely cause, a suggested fix, chat answers and the insights summary |
| Workflow / coordination | Worker pipeline plus Durable Objects | Steps: load data, calculate, look up history, explain each exception, save |
| User input | Chat panel, served by the Worker with static assets | The analyst asks questions in plain English. The page also has CSV upload, the demo button, and resolve or escalate with a note |
| Memory / state | Durable Objects | One per customer: issue history, status, analyst notes, audit trail. One per check: the calculated results and the chat history |

Design choices:

- **Workers with static assets instead of Pages.** This is Cloudflare's current guidance for new projects. One Worker serves both the page and the API.
- **A plain Worker pipeline instead of Workflows.** It keeps the demo button synchronous, so it can't hang. The README explains that the Worker and Durable Objects handle coordination, and that Workflows would be the next step for large batch or scheduled runs.

AI-assisted coding is allowed. Keep the full Claude Code prompt history for submission.

## Screen (single page)

1. **Upload CSV files:** usage records, invoice lines, plan terms and credit memos. Missing plans or memos fall back to the sample files.
2. **"Load sample data" button** runs a built-in demo with no files needed. Most reviewers will only use this, so it must work perfectly. A short guided checklist walks a first-time reviewer through it.
3. **"Check" button** runs reconciliation.
4. **Results:**
   - summary tiles;
   - filters and sorting by customer, period and status;
   - a *Data checks* panel listing rows that couldn't be read and notes on how the data was read.
5. **Each flagged issue shows:**
   - customer, expected amount, invoiced amount, difference;
   - the AI explanation;
   - any text quoted from the file, shown as text;
   - Resolve and Escalate buttons with a required note.

   Resolved issues are final and move to a Resolved list.
6. **Insights,** computed in code:
   - exposure, split into overcharged and undercharged and by status;
   - root causes;
   - aging of open and escalated issues;
   - recurrence;
   - customer hotspots;
   - a short AI summary checked against those numbers.
7. **Chat panel:** questions about the current results and a customer's history, from the panel or from an "Ask" button on each card.
8. **A per-customer history view** of past issues and decisions.

**AI fallback:** explanation calls run in parallel, up to 50 per check with a 10-second timeout each. If Workers AI errors, is slow, or has used its daily allowance, the page still shows the calculated results, with a short note saying why the explanation is unavailable. The demo never depends on the model responding.

## Data (CSV)

- **usage.csv:** customer_id, timestamp (ISO 8601 with a time zone), product, quantity
- **plans.csv:** customer_id, plan, price, included_quantity, overage_rate, discount_pct, tax_state, effective_date, and optionally product
- **invoices.csv:** invoice_id, customer_id, period, line_item, quantity, amount, tax, credits, credit_memo_id
- **credit_memos.csv:** credit_memo_id, customer_id, period, amount, reason, approved_by

### Calculation rules

- **Money and rounding:**
  - Money is integer cents, parsed from strings.
  - Rates are exact to 9 decimal places, with big-integer math for quantity × rate.
  - Rounding is half away from zero.
- **Proration:** the base fee is prorated by calendar day across plan changes.
- **Overage:** applies only to usage above the included quantity, using the plan in effect at period end.
  - Negative usage quantities are adjustments that net against the month.
  - A plan meters one product. Usage of any other product is reported as unpriced, never ignored silently.
- **Time zone:** usage is assigned to months in the billing time zone, America/New_York, not by UTC month. A timestamp's own offset is honored, and a timestamp without a time zone is refused.
- **Tax:** per line, from an illustrative state table. Oregon is 0%.
- **Line items** are recognized by how they start: base/plan, overage/usage, discount, credit.
  - Any other line can't be checked on its own, so the invoice's charges are compared as a whole.
- **Grouping:** a customer's invoices for one period are checked together. Each finding is filed on the invoice that holds the line.
- **Customer IDs** are matched without regard to case or surrounding spaces.

### Credit rule

A credit on an invoice is explained, not flagged, when its credit_memo_id points to a memo that:
- is approved;
- has the same customer, period and amount;
- hasn't already been applied on another invoice.

Anything else is flagged, with the reason. In addition:
- An approved memo that no invoice applies is flagged as a credit owed.
- Credits larger than an invoice's charges are flagged, because an invoice should not go below zero.

This mirrors real billing systems. Credit memos (Stripe credit notes, Zuora credit memos, ERP credit ledgers) are separate records with their own approval, and SLA service credits are approved outside the billing run.

### Rows that can't be read

- **Whole-file errors stop the check.** A file that can't be read as a whole (empty, missing a column, header only, over 20,000 rows) stops the check with one clear error, as does a set of files over 5 MB in total.
- **Bad rows are listed, and the rest of the file is used.** Each bad row is shown with its file, line and reason.
- **No customer is checked on partial data.** A customer with a rejected plan, usage or invoice row is marked "not checked", never reported as clean.
- **Rejected credit memos:** a rejected memo row only affects the credits that cite it.

## Planted cases in the sample data

1. Mid-month plan change billed at the old price for the full month (proration error)
2. Usage overage charged on total usage instead of usage above the included amount
3. Contract discount not applied
4. Sales tax for the wrong state. It recurs from September, so the demo shows the "seen before" suggestion
5. Duplicate invoice line
6. Time zone boundary: usage at 11:30 PM ET on the last day of the month is already the next month in UTC, so it lands on the wrong invoice period
7. Looks wrong but is correct: the invoice is lower than expected because a legitimate service credit was applied, backed by an approved credit memo. The app must explain it, not flag it as an error
8. Several clean invoices that should pass with no flags

## Test data

A separate suite in `test-data/`:
- 30 functional edge cases;
- malformed files;
- security attacks: XSS, formula injection, prompt injection, hostile customer IDs, CSV row injection, oversized fields;
- stress sets: 500 exceptions, and a 7.4 MB usage file.

An automated test uploads every set through the API, and `test-data/RESULTS.md` records the result for each case.
- **Generated, not committed:** the 7.4 MB file is recreated by a script.
- **One deliberate difference:** F22 is flagged because the app uses the billing time zone above, while the test-data README assumes UTC months.

## Persistence

- **One Durable Object per customer.** It stores each issue: type, amounts, status (open, resolved, escalated), analyst note, who decided and when.
- **Audit trail:**
  - Events are append-only, and a resolution is final, both enforced by database triggers.
  - A note is required to resolve or escalate.
- **Precedents:** when a new issue matches a past decided one for the same customer, the AI adds one suggestion line, for example "Same tax error in September, resolved by issuing a credit. Suggest the same." The analyst approves. AI suggests, human decides.
- **One Durable Object per check (review session).** It stores that check's calculated results and the chat about them, append-only, and deletes itself after a week.

## Chat

- The analyst asks questions such as "Why was this flagged?" or "Has this customer had this issue before?"
- **The context comes from the server, never from the page.**
  - When a check runs, the Worker stores its calculated results in the review session.
  - When a question is asked, the Worker adds the named customers' ledger history.
  - The page sends only the question.
- **All CSV text and analyst notes are labelled as data in the prompt, never instructions.** The prompt injection cases in `test-data/3-security` still apply.
- **The model never computes amounts.**
  - If a question needs a number that isn't in the results, the answer says so.
  - Any number in the answer that isn't in the calculated context discards the answer, even one that appears in quoted text, a note or the question.
  - Links and hidden characters are refused.
- **The answer lists the findings it relied on,** each checked to exist and linked to its card.
- **Limits:** 40 questions of up to 500 characters per check. The last three exchanges go along as conversation context.

## Security

- **Text from files and people:** links, email addresses, HTML, markdown links, and hidden or control characters are refused in CSV fields, notes, names and questions. IDs must be plain identifiers.
- **Rendering:** everything is shown as plain text. The page never uses innerHTML.
- **Requests:** a strict Content Security Policy, and same-origin JSON required for every POST (CSRF).
- **Limits:** on request size, rows, AI calls and questions.

## Out of scope (list in README as next steps)

- **Payments reconciliation:** cash received against invoices.
- **Direct integration with billing systems and usage pipelines.** In production this would read usage, invoices and credit memos from the billing system and usage pipeline directly instead of CSV exports.
- **Workflows** for large batch or scheduled reconciliation runs.
- **Authentication and multi-user roles** via Cloudflare Access. That enables:
  - separation of duties, so whoever escalated an issue cannot also resolve it;
  - per-user settings;
  - per-analyst metrics.
- **Month-over-month anomaly insights.** These need more months of sample data.
- **A production aggregate store for insights:** D1 or Analytics Engine.
- **Customer name mapping, a real tax engine, and voice input for chat.**

## Deliverables

- **Deployed app:** https://billing-reconciliation-assistant.denitza-krasteva.workers.dev
- **GitHub repo** with the code and README: https://github.com/denushkata/cloudflare-billing-assistant. The README covers purpose, design principle, design choices, how to run, planted cases and next steps.
- **Prompt history** from Claude Code.

## Build steps

1. Create a free Cloudflare account and install Wrangler (Cloudflare's command-line tool)
2. Scaffold the project with Claude Code from this spec
3. Build the deterministic reconciliation logic first and test it against the planted cases
4. Add Workers AI explanations with the fallback
5. Add Durable Object persistence and the history view
6. Build the front end as Worker static assets, with the demo button
7. Run the test-data suite and fix what it finds
8. Add the chat panel
9. Deploy, test the demo end to end, write the README
10. Export prompt history, push to GitHub, submit the link
