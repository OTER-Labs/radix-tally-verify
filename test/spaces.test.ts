/**
 * Tally document v22 — SPACES — driven end to end: parse the register, read the Gateway,
 * recompute, re-derive, re-serialize, re-hash. Same discipline as `legs-end-to-end.test.ts`: one
 * MATCH per fixture, and the weight-breakdown unit tests beside them, so a formula bug and a
 * wiring bug fail differently.
 *
 * Three things this file pins:
 *   1. A `Fungible` space's weight is the account's balance of ONE resource — no XRD, no LSU, no
 *      pool walk, no validators call at all (the branch short-circuits before any of that).
 *   2. A `Membership` space's weight is 1-or-0 per account, however many badges it holds, from
 *      the same non-fungible read path the concentrated-liquidity legs use.
 *   3. A v20 document — none of the four v22 keys, no fungible/membership leg — still verifies
 *      byte-identically through the whole pipeline (`document.test.ts` pins the same fact at the
 *      parser level; this pins it end to end).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { verifyTallyDocument } from "../src/verify.ts";
import {
  assetSymbolFor,
  computeAccountWeightBreakdown,
  computeAccountWeights,
  fetchResourceSymbolAt,
} from "../src/weights.ts";

import { ACCOUNT_A, ACCOUNT_B, FakeGateway, SNAPSHOT_SV, XRD, scenarioGateway } from "./fake-gateway.ts";

const hash = (doc: Record<string, unknown>): string => tallyHash(doc as unknown as Json);

const FUNGIBLE_RESOURCE = "resource_rdx1tfungible00000000000000000000000000000000000000001";
const MEMBERSHIP_RESOURCE = "resource_rdx1nmembership0000000000000000000000000000000000002";

/** An `entityDetails` response naming one resource's `symbol` metadata — the shape
 * `fetchResourceSymbolAt` reads (mirrors `backLink` in `legs-end-to-end.test.ts`). */
const symbolDetails = (resource: string, symbol: string) => ({
  items: [
    {
      address: resource,
      explicit_metadata: { items: [{ key: "symbol", value: { typed: { value: symbol } } }] },
    },
  ],
});

/** A resource that declares no `symbol` key at all. */
const noSymbolDetails = (resource: string) => ({
  items: [{ address: resource, explicit_metadata: { items: [] } }],
});

/** A Binding tally document with every field the verdict needs, over whatever the test varies. */
function bindingDoc(over: Record<string, unknown>): Record<string, unknown> {
  return {
    tally_doc_version: 22,
    consultation_id: "c-space",
    kind: "Binding",
    options: ["Reject", "Approve"],
    snapshot_state_version: SNAPSHOT_SV,
    excluded_accounts: [],
    quorum: "1",
    approval_threshold_pc: "50",
    min_affirmative_support: "0",
    min_unique_voters: 0,
    abstain_weight: "0",
    seats: 0,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
    withdrawn_excluded: null,
    mas_met: true,
    quorum_met: true,
    approved: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// The Fungible leg
// ---------------------------------------------------------------------------------------

/** A holds 300 of the space's resource, B holds 50. Two Gateway calls when driven through
 * `verifyTallyDocument`: the Global-aggregated fungible balances, then the resource's own
 * `symbol` metadata for the v22 `asset_symbol` check — no validators, no pool lookup, nothing
 * else. The unit tests below that call `computeAccountWeightBreakdown`/`computeAccountWeights`
 * directly never reach the second call; it sits unused in the queue, which is harmless. */
function fungibleGateway(symbol = "TAHU"): FakeGateway {
  return new FakeGateway()
    .onDetails({
      items: [
        {
          address: ACCOUNT_A,
          fungible_resources: { items: [{ resource_address: FUNGIBLE_RESOURCE, amount: "300" }] },
        },
        {
          address: ACCOUNT_B,
          fungible_resources: { items: [{ resource_address: FUNGIBLE_RESOURCE, amount: "50" }] },
        },
      ],
    })
    .onDetails(symbolDetails(FUNGIBLE_RESOURCE, symbol));
}

test("a Fungible space: weight is the account's balance of the one named resource", async () => {
  const breakdown = await computeAccountWeightBreakdown(
    fungibleGateway(),
    [ACCOUNT_A, ACCOUNT_B],
    SNAPSHOT_SV,
    { native_pools: { mode: "off" }, fungible: { resource: FUNGIBLE_RESOURCE } },
    XRD,
  );
  assert.equal(breakdown.get(ACCOUNT_A)?.fungible.toString(), "300");
  assert.equal(breakdown.get(ACCOUNT_A)?.total.toString(), "300");
  assert.equal(breakdown.get(ACCOUNT_A)?.xrd.toString(), "0");
  assert.equal(breakdown.get(ACCOUNT_B)?.fungible.toString(), "50");
  // Every other leg is off in this space, whatever the register says elsewhere.
  for (const b of breakdown.values()) {
    assert.equal(b.lsu.toString(), "0");
    assert.equal(b.poolUnits.toString(), "0");
    assert.equal(b.membership.toString(), "0");
  }
});

test("Fungible weights via computeAccountWeights match the breakdown total", async () => {
  const weights = await computeAccountWeights(
    fungibleGateway(),
    [ACCOUNT_A, ACCOUNT_B],
    SNAPSHOT_SV,
    { native_pools: { mode: "off" }, fungible: { resource: FUNGIBLE_RESOURCE } },
    XRD,
  );
  assert.equal(weights.get(ACCOUNT_A)?.toString(), "300");
  assert.equal(weights.get(ACCOUNT_B)?.toString(), "50");
});

test("a Fungible-space document: MATCH end to end, hash checked", async () => {
  const doc = bindingDoc({
    space_id: 3,
    weight_config: { kind: "Fungible", resource: FUNGIBLE_RESOURCE },
    term_seconds: 0,
    asset_symbol: "TAHU",
    weight_sources: { native_pools: { mode: "off" }, fungible: { resource: FUNGIBLE_RESOURCE } },
    votes: [
      { account: ACCOUNT_A, selection: [1], weight: "300" },
      { account: ACCOUNT_B, selection: [0], weight: "50" },
    ],
    totals: ["50", "300"],
    total_weight: "350",
    voter_count: 2,
    approve_weight: "300",
    reject_weight: "50",
  });
  const gw = fungibleGateway();
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
  // Short-circuited: the fungible-balances call, the symbol check, nothing else.
  assert.deepEqual(gw.calls, [`details:${ACCOUNT_A},${ACCOUNT_B}`, `details:${FUNGIBLE_RESOURCE}`]);
});

test("a Fungible-space document: a wrong published weight is FIGURES", async () => {
  const doc = bindingDoc({
    space_id: 3,
    weight_config: { kind: "Fungible", resource: FUNGIBLE_RESOURCE },
    asset_symbol: "TAHU",
    weight_sources: { native_pools: { mode: "off" }, fungible: { resource: FUNGIBLE_RESOURCE } },
    votes: [
      { account: ACCOUNT_A, selection: [1], weight: "999" }, // wrong — should be 300
      { account: ACCOUNT_B, selection: [0], weight: "50" },
    ],
    totals: ["50", "999"],
    total_weight: "1049",
    voter_count: 2,
    approve_weight: "999",
    reject_weight: "50",
  });
  const outcome = await verifyTallyDocument(doc, hash(doc), fungibleGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind === "figures") {
    assert.ok(outcome.differences.some((d) => d.field.startsWith(`votes[0].weight`)));
  }
});

// ---------------------------------------------------------------------------------------
// The asset_symbol check (v22): the resource's `symbol` metadata AT THE SNAPSHOT, compared
// against the document's own `asset_symbol` claim — a figures-class finding on mismatch.
// ---------------------------------------------------------------------------------------

test("assetSymbolFor: the Xrd rule is the literal \"XRD\" and makes no Gateway call", async () => {
  const gw = new FakeGateway(); // no responses queued — a call here would throw
  assert.equal(await assetSymbolFor(gw, null, SNAPSHOT_SV), "XRD");
  assert.deepEqual(gw.calls, []);
});

test("fetchResourceSymbolAt reads the resource's symbol metadata at the pinned state version", async () => {
  const gw = new FakeGateway().onDetails(symbolDetails(FUNGIBLE_RESOURCE, "TAHU"));
  assert.equal(await fetchResourceSymbolAt(gw, FUNGIBLE_RESOURCE, SNAPSHOT_SV), "TAHU");
});

test("fetchResourceSymbolAt is \"\" when the resource declares no symbol", async () => {
  const gw = new FakeGateway().onDetails(noSymbolDetails(FUNGIBLE_RESOURCE));
  assert.equal(await fetchResourceSymbolAt(gw, FUNGIBLE_RESOURCE, SNAPSHOT_SV), "");
});

test("a wrong published asset_symbol is a figures-class finding", async () => {
  const doc = bindingDoc({
    space_id: 3,
    weight_config: { kind: "Fungible", resource: FUNGIBLE_RESOURCE },
    asset_symbol: "WRONG", // the resource actually declares TAHU
    weight_sources: { native_pools: { mode: "off" }, fungible: { resource: FUNGIBLE_RESOURCE } },
    votes: [
      { account: ACCOUNT_A, selection: [1], weight: "300" },
      { account: ACCOUNT_B, selection: [0], weight: "50" },
    ],
    totals: ["50", "300"],
    total_weight: "350",
    voter_count: 2,
    approve_weight: "300",
    reject_weight: "50",
  });
  const outcome = await verifyTallyDocument(doc, hash(doc), fungibleGateway("TAHU"), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind === "figures") {
    assert.deepEqual(
      outcome.differences.find((d) => d.field === "asset_symbol"),
      { field: "asset_symbol", document: "WRONG", recomputed: "TAHU" },
    );
  }
});

test("asset_symbol \"\" MATCHes when the resource declares no symbol", async () => {
  const doc = bindingDoc({
    space_id: 3,
    weight_config: { kind: "Fungible", resource: FUNGIBLE_RESOURCE },
    asset_symbol: "",
    weight_sources: { native_pools: { mode: "off" }, fungible: { resource: FUNGIBLE_RESOURCE } },
    votes: [
      { account: ACCOUNT_A, selection: [1], weight: "300" },
      { account: ACCOUNT_B, selection: [0], weight: "50" },
    ],
    totals: ["50", "300"],
    total_weight: "350",
    voter_count: 2,
    approve_weight: "300",
    reject_weight: "50",
  });
  const gw = new FakeGateway()
    .onDetails({
      items: [
        {
          address: ACCOUNT_A,
          fungible_resources: { items: [{ resource_address: FUNGIBLE_RESOURCE, amount: "300" }] },
        },
        {
          address: ACCOUNT_B,
          fungible_resources: { items: [{ resource_address: FUNGIBLE_RESOURCE, amount: "50" }] },
        },
      ],
    })
    .onDetails(noSymbolDetails(FUNGIBLE_RESOURCE));
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

// ---------------------------------------------------------------------------------------
// The Membership leg
// ---------------------------------------------------------------------------------------

/** A holds two badges of the membership resource (still weighs 1), B holds one, C holds none.
 * Driven through `verifyTallyDocument`, one more call follows: the resource's own `symbol`
 * metadata for the v22 `asset_symbol` check. */
function membershipGateway(symbol = "MEMBER"): FakeGateway {
  return new FakeGateway()
    .onNonFungibleAmounts(ACCOUNT_A, {
      items: [{ resource_address: MEMBERSHIP_RESOURCE, amount: 2 }],
    })
    .onNonFungibleAmounts(ACCOUNT_B, {
      items: [{ resource_address: MEMBERSHIP_RESOURCE, amount: 1 }],
    })
    .onDetails(symbolDetails(MEMBERSHIP_RESOURCE, symbol));
}

test("a Membership space: weight is 1-or-0 per account, however many badges held", async () => {
  const breakdown = await computeAccountWeightBreakdown(
    membershipGateway(),
    [ACCOUNT_A, ACCOUNT_B, "account_rdx1nobody"],
    SNAPSHOT_SV,
    { native_pools: { mode: "off" }, membership: { resource: MEMBERSHIP_RESOURCE } },
    XRD,
  );
  assert.equal(breakdown.get(ACCOUNT_A)?.membership.toString(), "1", "two badges still weighs 1");
  assert.equal(breakdown.get(ACCOUNT_A)?.total.toString(), "1");
  assert.equal(breakdown.get(ACCOUNT_B)?.membership.toString(), "1");
  assert.equal(breakdown.get("account_rdx1nobody")?.membership.toString(), "0");
  for (const b of breakdown.values()) {
    assert.equal(b.xrd.toString(), "0");
    assert.equal(b.fungible.toString(), "0");
  }
});

test("a Membership-space document: MATCH end to end, hash checked", async () => {
  const doc = bindingDoc({
    space_id: 5,
    weight_config: { kind: "Membership", resource: MEMBERSHIP_RESOURCE },
    asset_symbol: "MEMBER",
    weight_sources: { native_pools: { mode: "off" }, membership: { resource: MEMBERSHIP_RESOURCE } },
    votes: [
      { account: ACCOUNT_A, selection: [1], weight: "1" },
      { account: ACCOUNT_B, selection: [1], weight: "1" },
    ],
    totals: ["0", "2"],
    total_weight: "2",
    voter_count: 2,
    approve_weight: "2",
    reject_weight: "0",
  });
  const gw = membershipGateway();
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
  // Short-circuited: one Global-aggregated collection-amount page per account, the symbol
  // check, nothing else (no fungibles, no validators, no local-id walk).
  assert.deepEqual(gw.calls, [
    `nf-amounts:${ACCOUNT_A}`,
    `nf-amounts:${ACCOUNT_B}`,
    `details:${MEMBERSHIP_RESOURCE}`,
  ]);
});

// ---------------------------------------------------------------------------------------
// The v20-document-still-verifies regression: no v22 key anywhere, the ordinary XRD pipeline,
// exactly as it verified before this port existed.
// ---------------------------------------------------------------------------------------

test("a v20 document (no space_id / weight_config / term_seconds / asset_symbol) still MATCHes", async () => {
  const doc = bindingDoc({
    tally_doc_version: 20,
    weight_sources: { native_pools: { mode: "all" } },
    votes: [
      { account: ACCOUNT_A, selection: [1], weight: "125" },
      { account: ACCOUNT_B, selection: [1], weight: "52" },
    ],
    totals: ["0", "177"],
    total_weight: "177",
    voter_count: 2,
    approve_weight: "177",
    reject_weight: "0",
  });
  const outcome = await verifyTallyDocument(doc, hash(doc), scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});
