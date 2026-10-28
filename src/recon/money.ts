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
  if (!Number.isSafeInteger(value)) throw new Error(`${field}: "${raw}" is too large`);
  return neg && value !== 0 ? -value : value; // "-0" reads as 0
}

export const parseCents = (raw: string, field: string) => parseScaled(raw, 2, field);
/** Rates per unit to 9 decimal places, e.g. $0.0000125 per request -> 12,500 nano-dollars. */
export const parseNanos = (raw: string, field: string) => parseScaled(raw, 9, field);
export const parseBasisPoints = (raw: string, field: string) => parseScaled(raw, 2, field); // "15" -> 1500

/** Whole numbers only; `signed` allows usage adjustments such as -2000. */
export function parseWholeNumber(raw: string, field: string, { signed = false } = {}): number {
  const s = raw.trim();
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(s)) throw new Error(`${field}: "${raw}" must be a whole number`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error(`${field}: "${raw}" is too large to count exactly`);
  return n === 0 ? 0 : n; // never -0
}

/** quantity x rate (nano-dollars per unit) -> cents. BigInt keeps billions of units at sub-cent rates exact. */
export function lineAmount(quantity: number, rateNanos: number): number {
  const n = BigInt(quantity) * BigInt(rateNanos);
  const d = 10_000_000n; // nano-dollars per cent
  const q = (n < 0n ? -n : n) * 2n + d;
  const cents = Number(q / (2n * d)) * (n < 0n ? -1 : 1);
  if (!Number.isSafeInteger(cents)) throw new Error("line amount is too large to compute exactly");
  return cents === 0 ? 0 : cents;
}

/** Tax on one line, rounded to the cent. */
export const taxOn = (amountCents: number, rateBp: number) => roundDiv(amountCents * rateBp, 10_000);

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
