import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtCompact } from "./utils";

// Mirrors web/src/lib/utils.ts's fmtTokens rules exactly (same algorithm,
// hand-kept in sync across the two separate TS projects) — the context-window
// column and the NewAPI credits-per-dollar label must read the same way.
test("fmtCompact: sub-1000 stays exact", () => {
  assert.equal(fmtCompact(0), "0");
  assert.equal(fmtCompact(42), "42");
  assert.equal(fmtCompact(750), "750");
  assert.equal(fmtCompact(999), "999");
});

test("fmtCompact: 1k-9999 keeps up to 1 decimal, trims trailing zero", () => {
  assert.equal(fmtCompact(1000), "1k");
  assert.equal(fmtCompact(1500), "1.5k");
  assert.equal(fmtCompact(2500), "2.5k");
});

test("fmtCompact: 10k-999k rounds to whole k", () => {
  assert.equal(fmtCompact(16_000), "16k");
  assert.equal(fmtCompact(200_000), "200k");
  assert.equal(fmtCompact(250_000), "250k");
  assert.equal(fmtCompact(500_000), "500k");
});

test("fmtCompact: >=1M uses up to 2 decimals, trims trailing zeros", () => {
  assert.equal(fmtCompact(1_000_000), "1M");
  assert.equal(fmtCompact(1_050_000), "1.05M");
  assert.equal(fmtCompact(2_000_000), "2M");
  assert.equal(fmtCompact(12_500_000), "12.5M");
});

test("fmtCompact: does not round 0.5M-scale values up to a misleading whole M", () => {
  // The bug this replaced: (500_000/1_000_000).toFixed(0) rounds 0.5 -> "1",
  // silently doubling a 500k rate into "1M".
  assert.notEqual(fmtCompact(500_000), "1M");
  assert.equal(fmtCompact(500_000), "500k");
});
