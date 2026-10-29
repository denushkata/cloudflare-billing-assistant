# Design Notes: How the AI Was Used Before and Around the Build

The full build history is in [PROMPTS.md](../PROMPTS.md). This file covers the planning that happened before Claude Code started, and the review decisions made alongside the build. It comes from two conversations with Claude on claude.ai, one of them in voice mode.

These are excerpts, not full transcripts; the rest of those conversations was unrelated. My prompts are lightly cleaned up from voice transcription, and Claude's replies are summarized.

## 1. Choosing what to build (October 27, voice mode)

**Understanding the platform first.** Before picking an idea, I asked Claude to explain what Cloudflare does and what kinds of apps run on its developer platform. I checked my own mental model against it:

> "Does it work a little bit like a load balancer... it sits in front of the company website, provides some services up front, and then redirects everything else to the website?"

Claude confirmed the reverse proxy model and explained that the developer platform (Workers, storage, Workers AI) is the newer hosting side, and that's what the assignment uses.

**Picking the idea.** Claude offered two options: a billing reconciliation assistant tied to the role, or a tax journal assistant based on my Oracle EPM background. I asked:

> "Would it be something that's related to the position, kind of like you said, billing? Or would it be something from my expertise?"

Decision: billing reconciliation, framed through my financial correctness background (close, accruals, reconciliation) and applied to their problem.

**Time-boxing the idea.** I asked how much the idea itself mattered, and time-boxed choosing it. Decision: the idea needs to be relevant and sensible, not clever. What matters is that it works, fits the brief, and shows how I work with AI.

**Showing billing understanding.** I come to billing from financial systems (close, accruals, reconciliation), so I wanted the app to show I understand how usage-based billing breaks. Decision: do it through the choice of planted errors, which should be the realistic ways billing actually breaks.

**Narrowing scope.** I first described it as reconciling bills against payments. Claude corrected that to usage against invoices, which is closer to what makes usage-based billing hard. I then asked:

> "Should we also add payments, or am I unnecessarily complicating it?"

Decision: leave payments out and list it as a next step.

**Realistic inputs.** I asked whether it's realistic for users to have CSV files of usage and invoices. Decision: yes, billing systems and data warehouses export CSV and analysts work in those exports. In production it would read from the billing system and usage pipeline directly, noted in the README.

## 2. Designing the planted cases

Claude proposed five classic billing errors: mid-month plan change billed at the old price, overage charged on total usage, missing contract discount, wrong-state sales tax, and a duplicate line, plus clean invoices. I asked:

> "Is there any other very bizarre exception that will show my nuanced thinking?"

Two more were added:
- **Time zone month boundary.** Usage at 11:30 PM Eastern on the 31st is already the 1st in UTC and lands on the wrong invoice. Relevant for a global company.
- **Looks wrong but is correct.** An invoice lower than expected because a legitimate service credit was applied. The app must explain it, not flag it. This shows care about false alarms, which matters to finance teams.

## 3. The core design principle

**Code calculates, AI explains.** All amounts, proration, overage, discounts, tax and credits are computed in deterministic code. The model never does math. It only explains each exception, suggests a likely cause and recommends a fix. The analyst decides. AI suggests, a person decides.

We also added a **"Load sample data"** button so reviewers can see the app work in one click. Most reviewers will only use that, so it has to work every time.

## 4. Writing the spec and directing Claude Code

The planning conversation produced a written spec, now in [docs/](<Cloudflare Assignment Spec - Billing Reconciliation Assistant.md>). My opening prompt to Claude Code (in [PROMPTS.md](../PROMPTS.md)) set the working rules:

- Give a build plan before writing any code, and wait for approval.
- Build the reconciliation logic first, with unit tests.
- Generate the sample data and a table of expected results for each planted case, for me to review before going further.
- Then add Workers AI, Durable Objects and the front end, in that order.
- Check with me before anything that touches my Cloudflare or GitHub accounts.
- Commit after each working step.

## 5. Reviewing Claude Code's build plan (October 27 and 28)

I reviewed Claude Code's recommendations with Claude in a separate chat before approving them.

**Workers with static assets instead of Pages.** Approved. It's Cloudflare's current guidance for new projects, and one Worker serving the page and the API is simpler.

**A plain Worker pipeline instead of Workflows.** Approved, so the demo button can't hang. Two conditions added:
- The AI step must fail gracefully. If Workers AI errors or is slow, the page still shows every calculated result. Explanation calls run in parallel.
- The README should say Workflows is the next step for large batch or scheduled runs, so the choice reads as deliberate.

**A separate file for credits.** Claude Code proposed it so code can tell a legitimate credit from an error. I asked:

> "Is it realistic for a separate credits CSV file?"

Yes. In real billing systems a credit is its own record (Stripe credit notes, Zuora credit memos, ERP credit ledgers) with its own ID and approval. SLA credits are approved outside the billing run. Decision: name it credit_memos.csv, have invoice lines reference the memo by ID, and flag any credit without a matching approved memo.

## 6. Testing beyond the sample data (October 28)

> "Can you generate files to be loaded for testing the site that are different from the sample files and exercise as many edge cases as you can think of. Please also add security exploits in the files."

Claude generated the [test-data/](../test-data/) suite with expected results:
- 30 functional edge cases, such as proration on the first and last day, rounding off by one cent, discounts applied twice, credit memos for the wrong customer or period, unbilled usage, time zone offsets and very large quantities
- Malformed files
- Security attacks: XSS, spreadsheet formula injection, prompt injection aimed at the model, hostile customer IDs, CSV row injection and oversized fields
- Stress sets: 500 exceptions at once and a 7.4 MB usage file

Claude Code then ran the suite through the API and recorded the results in [test-data/RESULTS.md](../test-data/RESULTS.md).

## 7. Checking the build against the brief

Rereading the assignment wording, I noticed it asks for "user input via chat or voice." The app at that point took CSV uploads and button clicks, so a strict reviewer could mark that component as missing.

Decision: add a chat panel where the analyst asks questions about the results and a customer's history. The same rules apply. Context is built in code, the model never computes amounts, any answer with a number the code didn't calculate is discarded, file text is treated as data, and chat can never change an issue's status.

## 8. Packaging the submission

- Public GitHub repo, verified to contain no secrets, local settings or build output.
- The full Claude Code history goes in PROMPTS.md.
- Planning conversations are included here as excerpts rather than share links.
