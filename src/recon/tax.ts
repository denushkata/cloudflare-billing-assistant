// Illustrative state-level sales tax rates in basis points (725 = 7.25%).
// Each non-zero rate is distinct so a wrong-state charge can be traced to a single state.
// Production would call a tax engine; this table only exists to make the demo deterministic.
export const STATE_TAX_BP: Readonly<Record<string, number>> = Object.freeze({
  CA: 725,
  CO: 290,
  FL: 600,
  NY: 400,
  OR: 0, // no state sales tax
  TX: 625,
  WA: 650,
});

/** Own keys only, so a state such as "constructor" can never resolve to something inherited. */
export const hasTaxRate = (state: string) => Object.hasOwn(STATE_TAX_BP, state);
