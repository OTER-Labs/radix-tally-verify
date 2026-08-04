/**
 * Cross-implementation agreement tests.
 *
 * The golden vector below is NOT computed by this package. It is the value the Rust implementation
 * pins in `backend/src/tally_engine.rs::the_golden_document_hashes_to_its_pinned_value`. Two
 * independent implementations agreeing on it is the entire point — it is what turns
 * `docs/canonical-tally-serialization.md` from a description of one codebase's behaviour into a
 * specification something else can be written against.
 *
 * If this test fails, do not "fix" the constant. One of the two implementations has departed from
 * the spec, and which one it is has to be established before either is trusted.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Dec } from "../src/decimal.ts";
import { canonicalize, tallyHash } from "../src/canonical.ts";

const TALLY_DOC_VERSION = 12;

test("the canonical form is sorted, compact and stringly typed", () => {
  // Declared deliberately out of key order, with a nested object also out of order.
  const doc = {
    version: TALLY_DOC_VERSION,
    zeta: true,
    alpha: null,
    weight: Dec.fromInt(10n).toString(),
    winners: [2, 0, 1],
    nested: { y: 1, x: 2 },
  };
  assert.equal(
    canonicalize(doc),
    '{"alpha":null,"nested":{"x":2,"y":1},"version":12,"weight":"10","winners":[2,0,1],"zeta":true}',
  );
});

test("the golden document hashes to the value the Rust implementation pins", () => {
  const doc = {
    version: TALLY_DOC_VERSION,
    consultation_id: "golden",
    total_weight: Dec.fromInt(1000n).toString(),
    voter_count: 3,
    quorum_met: true,
    withdrawn_excluded: null,
    winners: [1, 0],
  };
  assert.equal(
    tallyHash(doc),
    "1de8c45c17a878fd9fad05913f326a946768e8575bd451aeffe586cdd91b67b3",
    "two independent implementations must agree on the canonical bytes",
  );
});

test("decimals serialize minimally, and division truncates", () => {
  assert.equal(Dec.fromInt(10n).toString(), "10");
  assert.equal(Dec.ZERO.toString(), "0");
  assert.equal(Dec.fromInt(1n).div(Dec.fromInt(2n)).toString(), "0.5", "no padding to 18 places");
  assert.equal(
    Dec.fromInt(1n).div(Dec.fromInt(3n)).toString(),
    "0.333333333333333333",
    "truncating, not rounding — a verifier that rounds disagrees with the ledger",
  );
  assert.equal(
    Dec.fromInt(2n).div(Dec.fromInt(3n)).toString(),
    "0.666666666666666666",
    "still truncating where rounding would carry to ...667",
  );
});

test("round-tripping a decimal through its canonical string is exact", () => {
  for (const s of ["0", "1", "10", "0.5", "0.333333333333333333", "123456789.000000000000000001", "-7.25"]) {
    assert.equal(Dec.parse(s).toString(), s, `round trip: ${s}`);
  }
});

test("malformed decimals are refused rather than interpreted", () => {
  // Exponents, separators and over-long fractions are not part of the form scrypto emits. Accepting
  // them would mean a malformed document hashes to something plausible.
  for (const bad of ["1e18", "1_000", "+5", "", ".5", "5.", "0.1234567890123456789"]) {
    assert.throws(() => Dec.parse(bad), `should refuse: ${JSON.stringify(bad)}`);
  }
});

test("a float in a document is refused, not formatted", () => {
  assert.throws(
    () => canonicalize({ weight: 1.5 }),
    /Decimal STRING/,
    "emitting a float would make the encoding depend on a formatting choice",
  );
});

test("object keys sort by UTF-8 bytes, not UTF-16 code units", () => {
  // The two orderings disagree above U+FFFF. "\u{1F600}" (astral) is 0xF0.. in UTF-8 but a leading
  // surrogate 0xD83D in UTF-16, so it sorts AFTER "～" by bytes and BEFORE it by code unit.
  const out = canonicalize({ "\u{1F600}": 1, "～": 2 });
  assert.equal(out, '{"～":2,"😀":1}');
});
