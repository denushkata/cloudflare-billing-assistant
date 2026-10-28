# Expected results for the sample data

Period: October 2026 (31 days). Billing time zone: America/New_York. Product: `bandwidth_gb`.
Every number below is asserted in `test/recon.test.ts`.

## Planted cases

"Difference" means invoiced minus expected. Positive means the customer was overcharged.

| # | Invoice | Customer | What's planted | Finding | Severity | Expected | Invoiced | Difference |
|---|---|---|---|---|---|---|---|---|
| 1 | INV-2026-10-001 | C001 | Upgraded Starter $200 → Pro $500 on Oct 16, billed $200 for the full month | `proration_error` | error | $354.84 base | $200.00 | −$154.84 |
| 2 | INV-2026-10-002 | C002 | 12,500 GB used, 10,000 included; overage charged on all 12,500 GB | `overage_on_total` | error | $125.00 overage | $625.00 | +$500.00 |
| 3 | INV-2026-10-003 | C003 | 15% contract discount missing | `discount_missing` | error | −$75.00 discount | $0.00 | +$75.00 |
| 4 | INV-2026-10-004 | C004 | WA customer taxed at the CA rate (7.25% instead of 6.5%) | `tax_wrong_state` | error | $35.62 tax | $39.73 | +$4.11 |
| 5 | INV-2026-10-005 | C005 | Overage line ($30.00 + $1.80 tax) appears twice | `duplicate_line` | error | $0.00 | $31.80 | +$31.80 |
| 6 | INV-2026-10-006 | C006 | 400 GB at 2026-11-01 03:30 UTC (Oct 31, 11:30 PM ET) left off October because usage was bucketed by UTC | `timezone_boundary` | error | $40.00 overage (800 GB) | $20.00 (400 GB) | −$20.00 |
| 7 | INV-2026-10-007 | C007 | Invoice $50 lower due to SLA credit backed by approved memo CM-2026-0142 | `credit_applied` | explained | −$50.00 credit | −$50.00 | $0.00 |
| 8 | INV-2026-10-008 | C008 | Clean: Starter, under included usage | none | clean | | | |
| 8 | INV-2026-10-009 | C009 | Clean: Business with overage and a 10% discount | none | clean | | | |
| 8 | INV-2026-10-010 | C010 | Clean: Pro with overage | none | clean | | | |

Summary: 10 invoices, 6 flagged, 1 explained, 3 clean. Seven findings in total, one per planted case, with no extras.

## Invoice totals

Totals include tax and approved credits.

| Invoice | Expected total | Invoiced total | Difference | Why it differs from the finding |
|---|---|---|---|---|
| INV-2026-10-001 | $377.02 | $212.50 | −$164.52 | Finding is pre-tax; TX tax on the $154.84 adds $9.68 |
| INV-2026-10-002 | $1,206.56 | $1,742.81 | +$536.25 | CA tax on the $500.00 adds $36.25 |
| INV-2026-10-003 | $442.00 | $520.00 | +$78.00 | NY tax on the $75.00 adds $3.00 |
| INV-2026-10-004 | $583.62 | $587.73 | +$4.11 | Same as the finding |
| INV-2026-10-005 | $243.80 | $275.60 | +$31.80 | Same as the finding |
| INV-2026-10-006 | $1,105.00 | $1,083.75 | −$21.25 | TX tax on the $20.00 adds $1.25 |
| INV-2026-10-007 | $464.50 | $464.50 | $0.00 | |
| INV-2026-10-008 | $212.50 | $212.50 | $0.00 | |
| INV-2026-10-009 | $982.80 | $982.80 | $0.00 | |
| INV-2026-10-010 | $557.70 | $557.70 | $0.00 | |

## Calculation rules

- **Money** is integer cents and is parsed from strings. No floating-point math is used.
- **Rounding** is half away from zero, to the cent.
- **Base fee** is prorated by day across plan changes and rounded once:
  (200.00 × 15 + 500.00 × 16) / 31 = $354.84.
- **Overage** is (usage − included) × rate, using the plan in effect on the last day of the period.
  - Usage is assigned to months in the billing time zone, not by the UTC calendar. Timestamps must carry a zone (`Z` or an offset such as `-04:00`).
  - Negative quantities are adjustments and net against the month's usage.
  - Rates are exact to 9 decimal places, and quantity × rate uses big-integer math.
  - The plan meters one product: the optional `product` column in plans.csv, or else the product most usage rows report. Usage of any other product is reported as unpriced.
- **Discount** is the contract percentage of base + overage, shown as a negative line.
- **Tax** is computed per line at the plan's state rate.
  - The rates are an illustrative table: CA 7.25%, CO 2.9%, FL 6%, NY 4%, OR 0% (no sales tax), TX 6.25%, WA 6.5%.
  - Each rate is unique, so a wrong-state charge can be traced to a single state.
- **Credits** are legitimate only when the line's `credit_memo_id` points to an approved memo with the same customer, period and amount.
  - A matching credit is reported as `explained`.
  - Anything else is flagged as `unsupported_credit`, with the reason:
    - no reference
    - unknown or rejected memo
    - wrong customer or period
    - no approver
    - already applied on another invoice
    - amount differs

    These cases are covered by unit tests and `test-data/`, not the sample data.
  - An approved memo that no invoice cites is flagged as `credit_not_applied`.
  - Approved credits larger than an invoice's charges are flagged as `credit_exceeds_charges`. An invoice should not go below zero.

### Across a customer's invoices

A customer's invoices for one period are checked together. Each finding is filed on the invoice that holds the line:
- A line billed on two invoices is a duplicate.
- A customer with plan terms but no invoice is `unbilled`.
- A line whose description doesn't start with a known component (`base`/`plan`, `overage`/`usage`, `discount`, `credit`) can't be checked on its own. The charges are compared as a whole (`unrecognized_line`).

### Rows that cannot be read

Each rejected row is listed with its file, line and reason.
- A customer with a rejected plan, usage or invoice row is not checked at all, so partial data is never reported as clean.
- Customer IDs are matched without regard to case or surrounding spaces.

See [test-data/RESULTS.md](../test-data/RESULTS.md) for the full set of edge cases.

### One root cause, one finding

Each check measures its component against the invoice's *own* other lines:
- The tax check recomputes tax on the invoiced lines.
- The discount check takes the percentage of the invoiced subtotal.

As a result, a missing discount does not also produce a tax finding, and an overage error does not produce a discount finding. That is why the finding differences above are pre-tax, and the invoice-total difference adds the tax effect.

### Duplicates

Duplicates are removed before the other checks. The duplicate finding carries the full extra charge, including tax.

## Insights on a fresh demo run

These are computed in code from the customers' ledgers, using the issue amounts shown on each card. Asserted in `test/insights.test.ts`.

| Metric | Expected |
|---|---|
| Issues in 2026-10 | 6 (case 7 is explained, not an issue) |
| Overcharged (refund exposure) | $610.91, all open: $500.00 + $75.00 + $31.80 + $4.11 |
| Undercharged (revenue leakage) | $174.84, all open: $154.84 + $20.00 |
| Root causes, largest first | Overage on total usage $500.00 · proration $154.84 · missing discount $75.00 · duplicate line $31.80 · time zone period $20.00 · wrong-state tax $4.11 |
| Repeats of an earlier decided issue | 1 of 6 (17%): C004's wrong-state sales tax, decided in September |
| Customer hotspots by open amount | C002, C001, C003, C005, C006, C004 (C004 marked as a repeat) |
| Aging of open or escalated issues | All 6 in 0–2 days |
| Median time to resolve | None resolved yet |

Resolving C002's issue and escalating C001's moves $500.00 to resolved and $154.84 to escalated, and removes C002 from the hotspots.

The AI summary may only repeat numbers from these metrics. A reply with any other number is discarded, and the code-written summary is shown instead.

## For the persistence step

The C004 tax case gets a seeded history entry: in September 2026 the same CA-instead-of-WA error was resolved with a credit (memo CM-2026-0119, already in `credit_memos.csv`). This lets the demo show the "same issue as before" suggestion on the first click.
