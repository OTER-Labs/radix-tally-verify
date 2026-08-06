/**
 * End-to-end classification: the three outcomes the README promises, plus the two ways the
 * tool refuses to answer. Everything runs against fixture Gateway responses — the network is
 * never involved, so a red test here means the logic moved, never that the Gateway did.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { GatewayError } from "../src/gateway.ts";
import type { GatewayClient } from "../src/gateway.ts";
import { verifyTallyDocument } from "../src/verify.ts";

import { ACCOUNT_A, ACCOUNT_B, XRD, scenarioGateway } from "./fake-gateway.ts";

/** A complete, self-consistent Binding document over the fixture scenario: A weighs 125,
 * B weighs 52, both approve. quorum 100 with a 2-voter floor, threshold 50, MAS 10. */
function goodDocument(): Record<string, Json> {
  return {
    tally_doc_version: 14,
    consultation_id: "consultation:test",
    title: "Should the fixture pass?",
    kind: "Binding",
    options: ["Reject", "Approve"],
    snapshot_state_version: 1000000,
    vote_start: 1754000000,
    vote_end: 1754604800,
    weight_rule: "weight(account) = XRD + LSUs at redemption + verified pool units (see spec)",
    weight_sources: { native_pools: { mode: "all" } },
    votes: [
      { account: ACCOUNT_A, selection: [1], weight: "125" },
      { account: ACCOUNT_B, selection: [1], weight: "52" },
    ],
    totals: ["0", "177"],
    total_weight: "177",
    abstain_weight: "0",
    voter_count: 2,
    quorum: "100",
    approval_threshold_pc: "50",
    min_affirmative_support: "10",
    min_unique_voters: 2,
    abstain_allowed: true,
    eligible_voting_power: "0",
    category: null,
    quorum_met: true,
    mas_met: true,
    seats: 0,
    final_seats: 0,
    parent_id: null,
    parent_candidate_index: null,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
    withdrawn_excluded: null,
    approve_weight: "177",
    reject_weight: "0",
    approved: true,
  };
}

class DeadGateway implements GatewayClient {
  entityDetails(): Promise<unknown> {
    return Promise.reject(new GatewayError("gateway unreachable at https://example.test: connect refused"));
  }
  entityFungiblesPage(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
  validatorsList(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
}

test("a correct document with the correct hash is a MATCH", async () => {
  const doc = goodDocument();
  const outcome = await verifyTallyDocument(doc, tallyHash(doc), scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("the envelope form is accepted and its hash used", async () => {
  const doc = goodDocument();
  const envelope = { document: doc, document_hash_blake2b: tallyHash(doc), cached: false };
  const outcome = await verifyTallyDocument(envelope, null, scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("without a hash the figures still check, and the outcome says the hash was not", async () => {
  const outcome = await verifyTallyDocument(goodDocument(), null, scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: false });
});

test("a published weight that is not the recomputed weight is FIGURES, the real signal", async () => {
  const doc = goodDocument();
  (doc["votes"] as Array<Record<string, Json>>)[0] = {
    account: ACCOUNT_A,
    selection: [1],
    weight: "124",
  };
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  assert.equal(outcome.differences.length, 1);
  assert.match(outcome.differences[0]?.field ?? "", /votes\[0\]\.weight/);
  assert.equal(outcome.differences[0]?.document, "124");
  assert.equal(outcome.differences[0]?.recomputed, "125");
});

test("figures match but hash differs is SERIALIZATION, not a lie", async () => {
  const doc = goodDocument();
  const wrongHash = "0".repeat(64);
  const outcome = await verifyTallyDocument(doc, wrongHash, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "serialization");
  if (outcome.kind === "serialization") assert.equal(outcome.expectedHash, wrongHash);
});

test("a tampered figure is FIGURES even when the hash would not match either", async () => {
  // Figures are checked first: the arithmetic is the signal, the hash only the encoding.
  const doc = goodDocument();
  doc["total_weight"] = "176";
  const outcome = await verifyTallyDocument(doc, "0".repeat(64), scenarioGateway(), XRD);
  assert.equal(outcome.kind, "figures");
});

test("gateway trouble is UNKNOWN, never a discrepancy", async () => {
  const outcome = await verifyTallyDocument(goodDocument(), null, new DeadGateway(), XRD);
  assert.equal(outcome.kind, "unknown");
  if (outcome.kind === "unknown") assert.match(outcome.reason, /unreachable/);
});

test("a document that is not a tally document is MALFORMED, a fourth thing entirely", async () => {
  const outcome = await verifyTallyDocument({ hello: "world" }, null, new DeadGateway(), XRD);
  assert.equal(outcome.kind, "malformed");
});
