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
import { computeAccountWeightBreakdown, computeAccountWeights } from "../src/weights.ts";

import { ACCOUNT_A, ACCOUNT_B, FakeGateway, SNAPSHOT_SV, XRD, scenarioGateway } from "./fake-gateway.ts";

const hash = (doc: Record<string, unknown>): string => tallyHash(doc as unknown as Json);

const FUNGIBLE_RESOURCE = "resource_rdx1tfungible00000000000000000000000000000000000000001";
const MEMBERSHIP_RESOURCE = "resource_rdx1nmembership0000000000000000000000000000000000002";

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

/** A holds 300 of the space's resource, B holds 50. One Gateway call: Global-aggregated
 * fungible balances of the two accounts — no validators, no pool lookup, nothing else. */
function fungibleGateway(): FakeGateway {
  return new FakeGateway().onDetails({
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
  });
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
  // Short-circuited: exactly the one fungible-balances call, nothing else.
  assert.deepEqual(gw.calls, [`details:${ACCOUNT_A},${ACCOUNT_B}`]);
});

test("a Fungible-space document: a wrong published weight is FIGURES", async () => {
  const doc = bindingDoc({
    space_id: 3,
    weight_config: { kind: "Fungible", resource: FUNGIBLE_RESOURCE },
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
// The Membership leg
// ---------------------------------------------------------------------------------------

/** A holds two badges of the membership resource (still weighs 1), B holds one, C holds none. */
function membershipGateway(): FakeGateway {
  return new FakeGateway()
    .onNonFungibles(ACCOUNT_A, {
      items: [
        {
          resource_address: MEMBERSHIP_RESOURCE,
          vaults: { items: [{ vault_address: "internal_vault_rdx1a", items: ["#1#", "#2#"] }] },
        },
      ],
    })
    .onNonFungibles(ACCOUNT_B, {
      items: [
        {
          resource_address: MEMBERSHIP_RESOURCE,
          vaults: { items: [{ vault_address: "internal_vault_rdx1b", items: ["#3#"] }] },
        },
      ],
    });
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
  // Short-circuited: one non-fungible page per account, nothing else (no fungibles, no validators).
  assert.deepEqual(gw.calls, [`non-fungibles:${ACCOUNT_A}`, `non-fungibles:${ACCOUNT_B}`]);
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
