// Demo history: one decided issue from September, so the first demo run can show the
// "seen before" suggestion. The amounts are consistent with credit memo CM-2026-0119
// in sample-data/credit_memos.csv (WA customer taxed at the CA rate on $536.00 of charges).

import type { SeedIssue } from "./ledger";

/** The spec's eight planted cases, by sample invoice. Shown as labels only when the sample data is used. */
export const PLANTED_CASES: Record<string, { number: number; title: string }> = {
  "INV-2026-10-001": { number: 1, title: "Mid-month plan change billed at the old price" },
  "INV-2026-10-002": { number: 2, title: "Overage charged on total usage" },
  "INV-2026-10-003": { number: 3, title: "Contract discount not applied" },
  "INV-2026-10-004": { number: 4, title: "Sales tax for the wrong state" },
  "INV-2026-10-005": { number: 5, title: "Duplicate invoice line" },
  "INV-2026-10-006": { number: 6, title: "Usage near midnight lands in the wrong period" },
  "INV-2026-10-007": { number: 7, title: "Looks wrong but is correct: approved credit" },
  "INV-2026-10-008": { number: 8, title: "Clean invoice" },
  "INV-2026-10-009": { number: 8, title: "Clean invoice" },
  "INV-2026-10-010": { number: 8, title: "Clean invoice" },
};

export const DEMO_HISTORY: Record<string, SeedIssue[]> = {
  C004: [
    {
      key: "INV-2026-09-004:tax_wrong_state",
      invoiceId: "INV-2026-09-004",
      period: "2026-09",
      type: "tax_wrong_state",
      severity: "error",
      expectedCents: 3484,
      invoicedCents: 3886,
      differenceCents: 402,
      summary: "Tax was charged at the CA rate instead of the WA rate of 6.5%.",
      status: "resolved",
      note: "Issued credit memo CM-2026-0119 for $4.02 and corrected the account's tax state to WA.",
      decidedBy: "m.chen",
      decidedAt: "2026-10-03T15:20:00Z",
      firstSeenAt: "2026-10-02T14:00:00Z",
    },
  ],
};
