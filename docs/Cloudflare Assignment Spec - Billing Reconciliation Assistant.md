# Billing Reconciliation Assistant: Build Spec

Cloudflare optional assignment for Senior Director of Engineering, Billing Platform (job 8152825). Written 2026-10-27. Updated 2026-10-27 after build plan review (Workers static assets, plain Worker pipeline, credit memos, AI fallback). Hand this file to Claude Code to build.

## Purpose

A small AI-powered app on Cloudflare that checks whether customer invoices match actual usage and plan terms, explains each mismatch in plain English, and keeps a persistent per-customer history of issues and resolutions.

Design principle: **code calculates, AI explains.** All financial math is deterministic code. The LLM never computes amounts. It explains exceptions one at a time, suggests a likely cause and a fix.

## Assignment requirements and how they're met

| Requirement | Cloudflare component | Role in the app |
|---|---|---|
| LLM | Workers AI (Llama 3.3) | Writes plain-English explanations, likely cause, suggested fix |
| Workflow / coordination | Worker pipeline plus Durable Object | Steps: load data, calculate, explain each exception, save |
| User input | Worker with static assets | Web page for CSV upload and demo button |
| Memory / state | Durable Objects | Per-customer issue history, status, analyst notes |

Design choices:

- Workers with static assets instead of Pages. This is Cloudflare's current guidance for new projects. One Worker serves both the page and the API.
- A plain Worker pipeline instead of Workflows. It keeps the demo button synchronous so it can't hang. The README explains that the Worker and Durable Object handle coordination, and that Workflows would be the next step for large batch or scheduled runs.

AI-assisted coding is allowed. Keep the full Claude Code prompt history for submission.

## Screen (single page)

1. Upload CSV files: usage records, invoice lines and credit memos. Plan terms come from plans.csv or are built into the sample data.
2. "Load sample data" button runs a built-in demo with no files needed. Most reviewers will only use this, so it must work perfectly.
3. "Check" button runs reconciliation.
4. Results list. Each flagged issue shows customer, expected amount, invoiced amount, difference, the AI explanation, and buttons for Resolved / Escalated plus a note field.
5. A per-customer history view of past issues and decisions.

AI fallback: explanation calls run in parallel. If Workers AI errors or is slow, the page still shows the calculated results with a short "explanation unavailable" note. The demo never depends on the model responding.

## Data (CSV)

- usage.csv: customer_id, timestamp (UTC), product, quantity
- plans.csv: customer_id, plan, price, included_quantity, overage_rate, discount_pct, tax_state, effective_date
- invoices.csv: invoice_id, customer_id, period, line_item, quantity, amount, tax, credits, credit_memo_id
- credit_memos.csv: credit_memo_id, customer_id, period, amount, reason, approved_by

Credit rule: a credit on an invoice that matches an approved credit memo by credit_memo_id is explained, not flagged. A credit with no matching approved memo is flagged. This mirrors real billing systems, where credit memos (Stripe credit notes, Zuora credit memos, ERP credit ledgers) are separate records with their own approval, and SLA service credits are approved outside the billing run.

## Planted cases in the sample data

1. Mid-month plan change billed at the old price for the full month (proration error)
2. Usage overage charged on total usage instead of usage above the included amount
3. Contract discount not applied
4. Sales tax for the wrong state
5. Duplicate invoice line
6. Time zone boundary: usage at 11:30 PM ET on the last day of the month is already the next month in UTC, so it lands on the wrong invoice period
7. Looks wrong but is correct: invoice lower than expected because a legitimate service credit was applied, backed by an approved credit memo. The app must explain it, not flag it as an error
8. Several clean invoices that should pass with no flags

## Persistence

- Durable Object per customer stores each issue: type, amounts, status (open, resolved, escalated), analyst note, timestamp
- Serves as an audit trail: who decided what and when
- When a new issue matches a past one for the same customer, the AI adds one suggestion line, for example "Same tax error in September, resolved by issuing a credit. Suggest the same." The analyst approves. AI suggests, human decides

## Out of scope (list in README as next steps)

- Payments reconciliation (cash received against invoices)
- Direct integration with billing systems and usage pipelines. In production this would read usage, invoices and credit memos from the billing system and usage pipeline directly instead of CSV exports
- Workflows for large batch or scheduled reconciliation runs
- Authentication and multi-user roles

## Deliverables

- Deployed app URL on Cloudflare
- GitHub repo with code and README (purpose, design principle, design choices, how to run, planted cases, next steps)
- Prompt history from Claude Code

## Build steps

1. Create a free Cloudflare account and install Wrangler (Cloudflare's command-line tool)
2. Scaffold the project with Claude Code from this spec
3. Build the deterministic reconciliation logic first and test it against the planted cases
4. Add Workers AI explanations with the fallback
5. Add Durable Object persistence and the history view
6. Build the front end as Worker static assets, with the demo button
7. Deploy, test the demo end to end, write the README
8. Export prompt history, push to GitHub, submit the link
