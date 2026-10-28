# Test data: results

Every case in [README.md](README.md) is checked automatically by [`test/test-data.test.ts`](../test/test-data.test.ts), which uploads each set through the same API the page uses. Run it with `npm test`.

Summary: **29 of 30 functional cases match the README.** F22 differs on purpose, because the app follows the build spec's time zone rule (see below). All malformed, security, stress and by-hand cases pass.

## How the app reads uploaded files

- **A bad row does not sink the file.** Each unreadable row is listed under *Data checks* with its file, line and reason, and the rest of the file is used.
- **No customer is checked on partial data.** A customer with a rejected plan, usage or invoice row is listed as *not checked*, never reported as clean.
- **Rejected credit memos.** A rejected memo row only affects invoices that cite that memo. Those credits are flagged as unsupported.
- **Whole-file errors stop the check.** If a file can't be read at all (empty, missing a column, header only, over 5 MB, over 20,000 rows), the check stops with one clear error.
- **Notes explain how the data was read.** The app adds a note whenever it interprets data, for example a customer ID whose case was changed, a usage adjustment, or an unpriced product.

## 1-functional

| Case | README expects | App result |
|---|---|---|
| F01–F07 | Pass | Clean |
| F08 | Flag −$0.01 | `base_mismatch` −$0.01 (no tolerance) |
| F09 | Pass, net $0 | Clean |
| F10 | Flag −$60 | `duplicate_line` −$60.00 |
| F11 | Flag, $19.20 tax should be $0 | `tax_mismatch` +$19.20 (Oregon is 0%) |
| F12 | Flag $25 unsupported | `unsupported_credit` −$25.00 |
| F13 | Flag, memo is for F14 | `unsupported_credit` −$40.00, "belongs to F14" |
| F14 | Flag, period mismatch | `unsupported_credit` −$40.00, "approved for 2026-08" |
| F15 | Flag, no approver | `unsupported_credit` −$30.00, "has no approver" |
| F16 | Flag the second use | INV-F16A explained. INV-F16B flagged: `unsupported_credit` −$25.00, "already applied on INV-F16A", plus `unrecognized_line` +$50.00, because the "Support add-on" is not in the plan terms |
| F17 | Flag, negative total | `credit_exceeds_charges` −$50.00 |
| F18 | Flag or info, credit owed | `credit_not_applied` +$60.00 on INV-F18 |
| F19 | Flag, unknown customer, no crash | `missing_plan` |
| F20 | Flag, unbilled $420 | `unbilled` −$420.00 |
| F21 | Pass | Clean (see the time zone note) |
| **F22** | Pass, 4,000 count | **Flagged** `timezone_boundary` −$30.00, by design (see below) |
| F23 | Pass if negatives net, state the rule | Clean, with a note that the −2,000 adjustment was netted |
| F24 | Pass, $15,432.10 | Clean. Rates are exact to 9 decimals, and big-integer math is used for the line amount |
| F25 | Pass, ai_neurons reported as unpriced | Clean, with a note: "50 ai_neurons … have no price in the plan terms" |
| F26 | Normalize to F26 and flag $90 | Read as F26 (with a note). `overage_mismatch` −$90.00 |
| F27 | Flag $300 duplicate billing | INV-F27A clean. INV-F27B `duplicate_line` +$300.00, "already billed on INV-F27A" |
| F28 | Pass | Clean |
| F29 | Flag +$2,700 | `base_mismatch` +$2,700.00 |
| F30 | Pass | Clean |

### Time zone: why F22 differs

The build spec's planted case 6 says usage at 11:30 PM Eastern on the last day of the month belongs to that month, and that bucketing by UTC month is the bug. The app therefore assigns usage to months in the billing time zone, America/New_York.

The test-data README assumes UTC months, so the two disagree on F22:

- `2026-10-31T21:30:00-04:00` is 9:30 PM on Oct 31 in New York, which makes it October usage.
- October's total is therefore 6,000, which gives a $30.00 overage that the invoice leaves off.
- The finding names the record and the rule.

F21 passes under either rule, though for different reasons. In New York time:

- 00:00 UTC on Oct 1 is still September 30.
- 00:00 UTC on Nov 1 is still October 31.

October's total is then 4,000, below the 5,000 included.

## 2-malformed

Each file was uploaded in place of the matching file in 1-functional. The replacement invoice files contain only F30, so the other 29 customers correctly show as *not invoiced*.

| File | Result |
|---|---|
| empty.csv | Refused: "Upload usage.csv and invoices.csv" |
| header_only_invoices.csv | Refused: "invoices.csv: has a header but no data rows" (not "all clean") |
| missing_column_invoices.csv | Refused: "invoices.csv: missing column(s) amount" |
| reordered_extra_columns_invoices.csv | Works: columns are matched by header name, and extra columns are ignored |
| bom_crlf_invoices.csv | Works |
| duplicate_header_invoices.csv | The repeated header is rejected as "repeats the header row", and the rest works |
| bad_rows_invoices.csv | 14 rows rejected, each with its reason (see the list below). F30 is not checked because 13 of its rows were rejected |
| bad_rows_usage.csv | All 9 rows rejected: US date, Feb 30, date only, no time zone, Unix seconds, blank, fractional, blank product, above the safe-integer limit |
| bad_rows_plans.csv | 150% and −10% discount, negative price, state "XX", and the ambiguous same-day M6 plans are rejected. Lowercase "or" is read as OR |
| credit_memos_bad.csv | Negative amount, "abc", and both copies of duplicated ID CM-M1 are rejected |

The 14 rows rejected from bad_rows_invoices.csv:
- embedded line break
- `ten`
- `$1,234.50`
- `1.234,50`
- blank amount
- `1e3`
- `NaN`
- `Infinity`
- `10/2026`
- `2026-13`
- `100.005`
- blank customer
- extra columns
- short row

Three rows were accepted:
- the quoted commas and quotes
- `-0`, read as 0
- the spaces around a number

## 3-security

| Attack | Result |
|---|---|
| XSS in line items, plan names, products and approvers | Rows containing HTML, `javascript:` or markdown links are rejected on upload. Other text is shown as plain text: nothing executes, and `{{7*7}}` displays literally. Checked in the browser with `alert` trapped: no calls, and no injected elements |
| Formula injection (`=`, `+`, `-`, `@`, tab, CR) | Shown as plain text. The app has no CSV export, so there is nothing to neutralize. If an export is added, it should prefix these with an apostrophe |
| Prompt injection P01–P06 | P03, P05 and P06 are rejected (HTML or links). For P01, P02 and P04, the text reaches the model labelled `quoted_from_files`, which the prompt marks as data, never as instructions. Amounts that appear only in quoted text (P01's "$1,000,000") make a reply invalid. Status changes only when an analyst clicks |
| Hostile customer IDs | `__proto__`, path traversal, SQL, null byte, RTL override, Cyrillic look-alike, zero-width space and 5,000 characters are all rejected. The look-alike and hidden characters are shown as `\u` escapes, so the reason can't be misread. `constructor`, `toString` and similar are valid IDs: they get their own ledgers and break nothing |
| CSV row injection (S-HDR) | The quoted newline stays inside one field, and that field is rejected for containing a line break. The fake $999,999 row never exists |
| Oversized field (S-LONG) | Rejected (line_item is limited to 200 characters). It is never sent to the model |

## 4-stress

| Set | Result |
|---|---|
| many_exceptions | All 500 calculated results appear. AI calls stop at 50 per check; the rest say so. When Workers AI is unavailable, every card still shows its numbers. Locally the run takes about 22 s with real Durable Objects, most of it creating 500 new customer ledgers |
| large_usage | 7.4 MB is over the 5 MB limit for one check. The page refuses it before uploading, with advice to split or summarize the export, and the server gives the same message. `usage.csv` is not committed: run `node test-data/4-stress/large_usage/generate-usage.mjs` to recreate an equivalent file |

## By hand

| Check | Result |
|---|---|
| Non-CSV renamed to .csv | Refused: "missing column(s) …". No crash |
| Same check twice at once | History is not doubled: issues are keyed by invoice and type |
| Resolve and escalate at once, in two tabs | One wins. The other gets "already resolved by tab a; resolutions are final". The audit trail shows one decision |
| XSS and a 5,000-character note | Refused: "cannot contain links, email addresses or HTML" and "longer than 1000 characters" |
| API called directly with hostile IDs, or another customer's issue | 400 "Invalid customer ID." or "no issue … for this customer". Cross-site POSTs get 403 |
