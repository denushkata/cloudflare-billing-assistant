// Recreates usage.csv for the large_usage stress test (200,000 rows, about 7.4 MB), which is too
// large to commit. Seeded, so every run writes the same file.
//   node test-data/4-stress/large_usage/generate-usage.mjs

import { writeFileSync } from "node:fs";

const ROWS = 200_000;
const CUSTOMERS = 500;

// mulberry32: a small seeded PRNG, so the file is identical on every machine.
let seed = 20261001;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (n) => Math.floor(random() * n);
const pad = (n) => String(n).padStart(2, "0");

const lines = ["customer_id,timestamp,product,quantity"];
for (let i = 0; i < ROWS; i++) {
  const customer = `L${String(i % CUSTOMERS).padStart(4, "0")}`;
  const timestamp = `2026-10-${pad(1 + pick(31))}T${pad(pick(24))}:${pad(pick(60))}:00Z`;
  lines.push(`${customer},${timestamp},requests,${1 + pick(20)}`);
}
const out = new URL("./usage.csv", import.meta.url);
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`Wrote ${ROWS.toLocaleString("en-US")} rows to ${out.pathname}`);
