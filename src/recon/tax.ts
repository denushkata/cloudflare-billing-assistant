// Illustrative state-level sales tax rates in basis points (725 = 7.25%).
// Each rate is distinct so a wrong-state charge can be traced to a single state.
// Production would call a tax engine; this table only exists to make the demo deterministic.
export const STATE_TAX_BP: Record<string, number> = {
  CA: 725,
  CO: 290,
  FL: 600,
  NY: 400,
  TX: 625,
  WA: 650,
};
