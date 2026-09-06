/**
 * `src/document.ts` parsing — the field set, not the verdict. Weight recomputation and full
 * MATCH/FIGURES pipelines for the two v22 space rules live in `test/spaces.test.ts`; this file
 * is about what a document PARSES to, including the backward-compatibility guarantee that
 * carries every earlier version through unchanged.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { canonicalize, tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { TALLY_DOC_VERSION, parseTallyDocument } from "../src/document.ts";

/** A minimal but complete Poll document — every field `parseTallyDocument` requires, nothing
 * v22 adds. Used to pin the "a v20 document still verifies" defaults. */
function v20Document(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tally_doc_version: 20,
    consultation_id: "c-v20",
    title: "A v20 document",
    kind: "Poll",
    options: ["Reject", "Approve"],
    snapshot_state_version: 1000000,
    vote_start: 1754000000,
    vote_end: 1754604800,
    weight_rule: "weight(account) = XRD balance (see spec)",
    weight_sources: { native_pools: { mode: "all" } },
    votes: [],
    totals: ["0", "0"],
    total_weight: "0",
    abstain_weight: "0",
    voter_count: 0,
    quorum: "0",
    approval_threshold_pc: "50",
    min_affirmative_support: "0",
    min_unique_voters: 0,
    abstain_allowed: true,
    eligible_voting_power: "0",
    category: null,
    quorum_met: false,
    mas_met: false,
    seats: 0,
    final_seats: 0,
    parent_id: null,
    parent_candidate_index: null,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
    withdrawn_excluded: null,
    approve_weight: null,
    reject_weight: null,
    approved: false,
    ...over,
  };
}

test("TALLY_DOC_VERSION is 22; 21 is not reused", () => {
  assert.equal(TALLY_DOC_VERSION, 22);
  assert.notEqual(TALLY_DOC_VERSION, 21);
});

// ---------------------------------------------------------------------------------------
// Backward compatibility: a document with none of the four v22 keys (and no fungible/
// membership leg) parses to exactly the defaults a space-0, pre-v22 document implies.
// ---------------------------------------------------------------------------------------

test("a v20 document — none of the four v22 keys present — defaults to space 0 / Xrd", () => {
  const { doc } = parseTallyDocument(v20Document());
  assert.equal(doc.spaceId, 0);
  assert.deepEqual(doc.weightConfig, { kind: "Xrd" });
  assert.equal(doc.termSeconds, 0);
  assert.equal(doc.assetSymbol, "XRD");
  assert.equal(doc.weightSources.fungible, undefined);
  assert.equal(doc.weightSources.membership, undefined);
});

// ---------------------------------------------------------------------------------------
// weight_config
// ---------------------------------------------------------------------------------------

test("weight_config: Xrd, Fungible and Membership all parse", () => {
  assert.deepEqual(
    parseTallyDocument(v20Document({ weight_config: { kind: "Xrd" } })).doc.weightConfig,
    { kind: "Xrd" },
  );
  assert.deepEqual(
    parseTallyDocument(v20Document({ weight_config: { kind: "Fungible", resource: "resource_rdx1abc" } }))
      .doc.weightConfig,
    { kind: "Fungible", resource: "resource_rdx1abc" },
  );
  assert.deepEqual(
    parseTallyDocument(v20Document({ weight_config: { kind: "Membership", resource: "resource_rdx1def" } }))
      .doc.weightConfig,
    { kind: "Membership", resource: "resource_rdx1def" },
  );
});

test("weight_config with an unknown kind is MALFORMED, not silently Xrd", () => {
  assert.throws(
    () => parseTallyDocument(v20Document({ weight_config: { kind: "Bogus" } })),
    /weight_config\.kind/,
  );
});

test("weight_config Fungible/Membership without a resource is MALFORMED", () => {
  assert.throws(
    () => parseTallyDocument(v20Document({ weight_config: { kind: "Fungible" } })),
    /weight_config\.resource/,
  );
});

// ---------------------------------------------------------------------------------------
// space_id / term_seconds / asset_symbol
// ---------------------------------------------------------------------------------------

test("space_id, term_seconds and asset_symbol carry through when present", () => {
  const { doc } = parseTallyDocument(
    v20Document({
      space_id: 7,
      weight_config: { kind: "Fungible", resource: "resource_rdx1t4golden" },
      term_seconds: 31_536_000,
      asset_symbol: "TAHU",
    }),
  );
  assert.equal(doc.spaceId, 7);
  assert.equal(doc.termSeconds, 31_536_000);
  assert.equal(doc.assetSymbol, "TAHU");
});

test("asset_symbol may be the empty string — a resource that declares none, not an error", () => {
  const { doc } = parseTallyDocument(
    v20Document({
      space_id: 3,
      weight_config: { kind: "Fungible", resource: "resource_rdx1abc" },
      asset_symbol: "",
    }),
  );
  assert.equal(doc.assetSymbol, "");
});

// ---------------------------------------------------------------------------------------
// weight_sources.fungible / .membership
// ---------------------------------------------------------------------------------------

test("weight_sources.fungible and .membership parse when present, absent otherwise", () => {
  const fungible = parseTallyDocument(
    v20Document({
      weight_sources: { native_pools: { mode: "off" }, fungible: { resource: "resource_rdx1f" } },
    }),
  ).doc.weightSources;
  assert.deepEqual(fungible.fungible, { resource: "resource_rdx1f" });
  assert.equal(fungible.membership, undefined);

  const membership = parseTallyDocument(
    v20Document({
      weight_sources: { native_pools: { mode: "off" }, membership: { resource: "resource_rdx1m" } },
    }),
  ).doc.weightSources;
  assert.deepEqual(membership.membership, { resource: "resource_rdx1m" });
  assert.equal(membership.fungible, undefined);
});

test("weight_sources.fungible without a resource is MALFORMED", () => {
  assert.throws(
    () =>
      parseTallyDocument(
        v20Document({ weight_sources: { native_pools: { mode: "off" }, fungible: {} } }),
      ),
    /weight_sources\.fungible\.resource/,
  );
});

test("weight_sources.membership without a resource is MALFORMED", () => {
  assert.throws(
    () =>
      parseTallyDocument(
        v20Document({ weight_sources: { native_pools: { mode: "off" }, membership: {} } }),
      ),
    /weight_sources\.membership\.resource/,
  );
});

// ---------------------------------------------------------------------------------------
// The v22 golden vector — the value the reference implementation pins for the four space keys.
//
// This is NOT parsed through parseTallyDocument — like the reference test it reproduces, it
// pins the canonical BYTES of the four new keys directly, so the shape a challenger recomputes
// from is checked independently of this tool's own parser.
// ---------------------------------------------------------------------------------------

test("the v22 golden vector: the four new keys' canonical bytes and hash", () => {
  const doc = {
    version: 22,
    consultation_id: "golden-v22",
    space_id: 7,
    weight_config: { kind: "Fungible", resource: "resource_rdx1t4golden" },
    term_seconds: 31_536_000,
    asset_symbol: "TAHU",
    total_weight: "1000",
  };
  const payload = canonicalize(doc as unknown as Json);
  assert.equal(
    payload,
    '{"asset_symbol":"TAHU","consultation_id":"golden-v22","space_id":7,"term_seconds":31536000,"total_weight":"1000","version":22,"weight_config":{"kind":"Fungible","resource":"resource_rdx1t4golden"}}',
  );
  assert.equal(
    tallyHash(doc as unknown as Json),
    "5962fc7e825bb75c52fda7ab43ef217b29bc674fa401cb1e38f9b6d33ffdecfc",
  );
});
