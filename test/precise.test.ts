/**
 * Scrypto `PreciseDecimal` — the 36-place fixed point the v17 legs are evaluated in.
 *
 * The two scales are not interchangeable, and this file exists to keep them from becoming so.
 * Every value a tally document publishes is an 18-place `Decimal`; the tick power and the
 * removable-amount formula are evaluated at 36 and narrowed at the end. Doing the tick
 * arithmetic at 18 places lands on different digits, and the digits are hashed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Dec } from "../src/decimal.ts";
import { PDec, PRECISE_DECIMAL_PLACES } from "../src/precise.ts";

test("36 places round-trip through the canonical string exactly", () => {
  for (const s of [
    "0",
    "1",
    "-7.25",
    "0.847502416631256480901344166758536566",
    "2016.738774772895807708564745848344742595",
    "1.000049998750062496094023416993798697",
  ]) {
    assert.equal(PDec.parse(s).toString(), s, `round trip: ${s}`);
  }
});

test("malformed values are refused rather than interpreted", () => {
  // 37 places is one more than the representation carries. Accepting it would silently drop a
  // digit and hash to something plausible.
  for (const bad of ["1e36", "1_000", "+5", "", ".5", "5.", `0.${"1".repeat(37)}`]) {
    assert.throws(() => PDec.parse(bad), `should refuse: ${JSON.stringify(bad)}`);
  }
});

test("multiplication and division truncate toward zero, never round", () => {
  const one = PDec.ONE;
  const three = PDec.parse("3");
  assert.equal(
    (one.div(three) as PDec).toString(),
    `0.${"3".repeat(36)}`,
    "one third, truncated at 36 places",
  );
  assert.equal(
    (PDec.parse("2").div(three) as PDec).toString(),
    `0.${"6".repeat(35)}6`,
    "two thirds keeps truncating where rounding would carry to ...667",
  );
  // Division by zero is `None`, not a throw and not an infinity — the caller decides.
  assert.equal(one.div(PDec.ZERO), null);
});

test("the power's negative branch takes the reciprocal FIRST, at 36 places", () => {
  // This is the semantics `WEIGHT_RULE` states and the reference implementation computes:
  // S(-t) = (1/base)^t, NOT 1/(base^t). The two differ in the last places, and a port that
  // inverted at the end would disagree with the ledger on every below-range position.
  const base = PDec.parse("1.000049998750062496094023416993798697");
  const exp = 7260n;

  const reciprocalFirst = (PDec.ONE.div(base) as PDec).powi(exp) as PDec;
  assert.equal(
    base.powi(-exp)?.toString(),
    reciprocalFirst.toString(),
    "the implementation must be reciprocal-then-power",
  );

  const powerFirst = PDec.ONE.div(base.powi(exp) as PDec) as PDec;
  assert.notEqual(
    reciprocalFirst.toString(),
    powerFirst.toString(),
    "and the two orderings really do differ, so the choice is not academic",
  );
});

test("the power's trivial exponents are exact", () => {
  const base = PDec.parse("1.5");
  assert.equal(base.powi(0n)?.toString(), "1");
  assert.equal(base.powi(1n)?.toString(), "1.5");
  assert.equal(base.powi(2n)?.toString(), "2.25");
  assert.equal(base.powi(3n)?.toString(), "3.375");
  // The odd branch multiplies by the base at the end; the even one squares and halves. Both
  // paths must reach the same number for the same exponent.
  assert.equal(base.powi(4n)?.toString(), "5.0625");
});

test("a value that leaves I256 is null, never a clamp", () => {
  // The caller turns this into a named refusal. A silently clamped price would value a position
  // wrongly instead of loudly, and the wrong value is the one that gets hashed and bonded on.
  const big = PDec.parse("100000000000000000000000000000000000");
  assert.equal(big.powi(100n), null, "an unrepresentable power is None, not a maximum");
});

test("narrowing to the tally's 18 places truncates toward zero", () => {
  const wide = PDec.parse("254.929665520653811333999999999999999999");
  const narrow = Dec.fromPreciseSubunits(wide.sub, PRECISE_DECIMAL_PLACES);
  assert.equal(
    narrow?.toString(),
    "254.929665520653811333",
    "the extra places are dropped, not rounded up",
  );

  // Negative values truncate toward zero too, which is what `RoundingMode::ToZero` means in both
  // directions — a floor would move a negative value away from zero instead.
  const negative = PDec.parse("-1.9999999999999999999");
  assert.equal(
    Dec.fromPreciseSubunits(negative.sub, PRECISE_DECIMAL_PLACES)?.toString(),
    "-1.999999999999999999",
  );

  // A 36-place value too large for the tally's I192 is null rather than a saturated maximum.
  // PreciseDecimal's I256 reaches about 5.8e40; Decimal's I192 stops at about 3.1e39, so 1e40
  // is representable in one scale and not the other — exactly the gap the narrowing must catch.
  const huge = PDec.parse("1".padEnd(41, "0"));
  assert.ok(huge.isPositive(), "1e40 is representable at 36 places");
  assert.equal(
    Dec.fromPreciseSubunits(huge.sub, PRECISE_DECIMAL_PLACES),
    null,
    "but not at 18, and the answer is a refusal rather than a saturated maximum",
  );
});

test("truncating an 18-place Decimal to a divisibility rounds toward zero in both directions", () => {
  assert.equal(Dec.parse("1.987654321").truncateToPlaces(4).toString(), "1.9876");
  assert.equal(Dec.parse("-1.987654321").truncateToPlaces(4).toString(), "-1.9876");
  assert.equal(Dec.parse("1.987654321").truncateToPlaces(0).toString(), "1");
  assert.equal(Dec.parse("-1.987654321").truncateToPlaces(0).toString(), "-1");
});
