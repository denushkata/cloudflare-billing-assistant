// All money is integer cents. Rates are integer micro-dollars per unit;
// percentages are integer basis points. No floating-point math touches money.

/** Integer division rounded half away from zero. `d` must be positive. */
export function roundDiv(n: number, d: number): number {
  const a = Math.abs(n) * 2 + d;
  const q = (a - (a % (2 * d))) / (2 * d); // exact integer floor, no float rounding
  return n < 0 && q !== 0 ? -q : q;
}

/** Parse a decimal string into an integer scaled by 10^scale, without floats. */
export function parseScaled(raw: string, scale: number, field: string): number {
  const s = raw.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${field}: "${raw}" is not a number`);
  const [, neg, whole, frac = ""] = m;
  if (frac.length > scale) throw new Error(`${field}: "${raw}" has more than ${scale} decimal places`);
  const value = Number(whole) * 10 ** scale + Number(frac.padEnd(scale, "0") || "0");
  return neg ? -value : value;
}

export const parseCents = (raw: string, field: string) => parseScaled(raw, 2, field);
export const parseMicros = (raw: string, field: string) => parseScaled(raw, 6, field);
export const parseBasisPoints = (raw: string, field: string) => parseScaled(raw, 2, field); // "15" -> 1500

export function parseWholeNumber(raw: string, field: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${field}: "${raw}" must be a whole number`);
  return Number(raw.trim());
}

/** quantity x rate (micro-dollars per unit) -> cents */
export const lineAmount = (quantity: number, rateMicros: number) => roundDiv(quantity * rateMicros, 10_000);

/** Tax on one line, rounded to the cent. */
export const taxOn = (amountCents: number, rateBp: number) => roundDiv(amountCents * rateBp, 10_000);

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
