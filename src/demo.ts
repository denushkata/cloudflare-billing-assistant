// Demo history: one decided issue from September, so the first demo run can show the
// "seen before" suggestion. The amounts are consistent with credit memo CM-2026-0119
// in sample-data/credit_memos.csv (WA customer taxed at the CA rate on $536.00 of charges).

import type { SeedIssue } from "./ledger";

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
