/**
 * End-to-end classification: the three outcomes the README promises, plus the two ways the
 * tool refuses to answer. Everything runs against fixture Gateway responses — the network is
 * never involved, so a red test here means the logic moved, never that the Gateway did.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { TALLY_DOC_VERSION } from "../src/document.ts";
import { GatewayError } from "../src/gateway.ts";
import type { GatewayClient } from "../src/gateway.ts";
import { verifyTallyDocument } from "../src/verify.ts";

import { ACCOUNT_A, ACCOUNT_B, XRD, scenarioGateway } from "./fake-gateway.ts";

/** A complete, self-consistent Binding document over the fixture scenario: A weighs 125,
 * B weighs 52, both approve. quorum 100 with a 2-voter floor, threshold 50, MAS 10. */
function goodDocument(): Record<string, Json> {
  return {
    tally_doc_version: TALLY_DOC_VERSION,
    excluded_accounts: [],
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
  entityDetailsAtTimestamp(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
  entityDetailsVault(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
  entityNonFungiblesPage(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
  entityNonFungibleVaultsPage(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
  entityNonFungibleVaultIdsPage(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
  nonFungibleData(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
  keyValueStoreKeys(): Promise<unknown> {
    return Promise.reject(new GatewayError("unreachable"));
  }
  keyValueStoreData(): Promise<unknown> {
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

/* ------------------------------------------------------------------------------------------
 * The DAO-controlled-funds bar (v15). A barred ballot stays in `votes` carrying `excluded:
 * true`; the register that decides which ballots those are travels at the top level, inside the
 * hash, for the same reason `weight_sources` does.
 * ---------------------------------------------------------------------------------------- */

/**
 * The fixture consultation with account A barred. A's 125 reaches nothing: totals, total_weight,
 * voter_count and the verdict are all as if A had stayed away — which drops the tally under its
 * unchanged quorum of 100, since only B's 52 is left.
 */
function barredDocument(): Record<string, Json> {
  const doc = goodDocument();
  doc["excluded_accounts"] = [ACCOUNT_A];
  doc["votes"] = [
    { account: ACCOUNT_A, selection: [1], weight: "125", excluded: true },
    { account: ACCOUNT_B, selection: [1], weight: "52" },
  ];
  doc["totals"] = ["0", "52"];
  doc["total_weight"] = "52";
  doc["voter_count"] = 1;
  doc["min_unique_voters"] = 1; // so the weight leg is the only thing that can fail
  doc["quorum_met"] = false;
  doc["mas_met"] = true; // 52 clears the MAS floor of 10 — the quorum leg is what refuses
  doc["approve_weight"] = "52";
  doc["reject_weight"] = "0";
  doc["approved"] = false;
  return doc;
}

test("a document barring an account under the DAO-controlled-funds rule is a MATCH", async () => {
  const doc = barredDocument();
  const outcome = await verifyTallyDocument(doc, tallyHash(doc), scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("the barred account's published weight is still recomputed and checked", async () => {
  // Excluding a ballot does not put its weight beyond challenge. If it did, "excluded" would be
  // a place to hide a wrong figure.
  const doc = barredDocument();
  (doc["votes"] as Array<Record<string, Json>>)[0] = {
    account: ACCOUNT_A,
    selection: [1],
    weight: "999",
    excluded: true,
  };
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  assert.equal(outcome.differences.length, 1);
  assert.match(outcome.differences[0]?.field ?? "", /votes\[0\]\.weight/);
  assert.equal(outcome.differences[0]?.recomputed, "125");
});

test("a ballot flagged excluded that the register does not bar is FIGURES", async () => {
  // The flag is a claim; the register decides. A publisher that dropped a ballot from the tally
  // without listing the account is asserting an exclusion nobody can check — and the recomputed
  // figures, which counted that ballot, say so.
  const doc = goodDocument();
  (doc["votes"] as Array<Record<string, Json>>)[0] = {
    account: ACCOUNT_A,
    selection: [1],
    weight: "125",
    excluded: true,
  };
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const fields = outcome.differences.map((d) => d.field);
  assert.ok(
    fields.some((f) => /votes\[0\]\.excluded/.test(f)),
    `the unbacked flag itself must be reported, got ${JSON.stringify(fields)}`,
  );
});

test("a barred account whose ballot was counted anyway is FIGURES", async () => {
  // The mirror image: the register bars A, but the published figures still contain A's 125.
  const doc = goodDocument();
  doc["excluded_accounts"] = [ACCOUNT_A];
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const fields = outcome.differences.map((d) => d.field);
  for (const expected of ["totals[1]", "total_weight", "voter_count", "quorum_met"]) {
    assert.ok(fields.includes(expected), `${expected} must differ, got ${JSON.stringify(fields)}`);
  }
});

test("an excluded_accounts register that is not strictly ascending is MALFORMED", async () => {
  // Arrays are content under the canonical encoding, so the order is part of what the hash
  // commits to: a register the reference implementation cannot have emitted is not a document
  // whose hash anyone will reproduce.
  const doc = barredDocument();
  doc["excluded_accounts"] = [ACCOUNT_B, ACCOUNT_A];
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "malformed");
  if (outcome.kind === "malformed") assert.match(outcome.reason, /excluded_accounts/);
});

/**
 * A v14 document: no `excluded_accounts`, no `excluded` flags, the field set exactly as it was
 * before the bar existed. It must verify precisely as it did then — an absent register is `[]`
 * and an absent flag is `false`, so nothing is barred and every figure is the old one.
 */
function v14Document(): Record<string, Json> {
  const doc = goodDocument();
  doc["tally_doc_version"] = 14;
  delete doc["excluded_accounts"];
  return doc;
}

test("a v14 document, with neither the register nor the flags, verifies exactly as before", async () => {
  const doc = v14Document();
  assert.equal("excluded_accounts" in doc, false, "the fixture must really be the old field set");
  const outcome = await verifyTallyDocument(doc, tallyHash(doc), scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

/* ------------------------------------------------------------------------------------------
 * The published Grade Quantile, end to end (v15, Proposal & Voting Framework §6.5).
 *
 * A two-candidate Majority Judgment election over the fixture accounts: A weighs 125 and grades
 * both candidates Good, B weighs 52 and grades both Excellent. 52 of the 177 cast is 29.4% — a
 * share that reaches a quantile of one-quarter and does not reach three-fifths, so the two
 * fractions settle these identical ballots two grades apart. Which one the verifier applies is
 * therefore visible in the result, which is the only way to prove it reads the field at all.
 * ---------------------------------------------------------------------------------------- */

/** The election, minus the `majority_judgment` block that the quantile decides. */
function mjElection(): Record<string, Json> {
  const doc = goodDocument();
  doc["kind"] = "Election";
  doc["options"] = [];
  doc["seat_rule"] = "MajorityJudgment";
  doc["seats"] = 2;
  doc["final_seats"] = 2;
  // A: candidate 0 Good (0*5+2), candidate 1 Good (1*5+2). B: both Excellent.
  doc["votes"] = [
    { account: ACCOUNT_A, selection: [2, 7], weight: "125" },
    { account: ACCOUNT_B, selection: [0, 5], weight: "52" },
  ];
  doc["totals"] = ["52", "0", "125", "0", "0", "52", "0", "125", "0", "0"];
  doc["total_weight"] = "177";
  doc["abstain_weight"] = "0";
  doc["voter_count"] = 2;
  doc["quorum"] = "100";
  doc["min_unique_voters"] = 2;
  doc["approval_threshold_pc"] = "0";
  doc["min_affirmative_support"] = "0";
  doc["quorum_met"] = true;
  doc["winners"] = [0, 1];
  // Approve/Reject mean nothing outside a Binding consultation.
  doc["mas_met"] = null;
  doc["approve_weight"] = null;
  doc["reject_weight"] = null;
  doc["approved"] = null;
  return doc;
}

/** The MJ block for a candidate settling at `qualifying`, with the gauge that follows from it. */
function mjBlock(qualifying: number, above: string, below: string, quantile: Json): Json {
  const candidate = (i: number): Json => ({
    candidate_index: i,
    by_grade: ["52", "0", "125", "0", "0"],
    cast: "177",
    qualifying_grade: qualifying,
    above,
    below,
  });
  return {
    grades: ["Excellent", "Very Good", "Good", "Acceptable", "Poor"],
    minimum_qualifying_grade: "Good",
    ...(quantile === null ? {} : { grade_quantile: quantile }),
    candidates: [candidate(0), candidate(1)],
    referred_tie_unresolved: [],
    invalid_ballots: [],
  };
}

/** Publishing one-quarter: 52 * 4 = 208 >= 177 * 1, so Excellent qualifies immediately. */
function quarterQuantileDocument(): Record<string, Json> {
  const doc = mjElection();
  doc["majority_judgment"] = mjBlock(0, "0", "125", { numerator: 1, denominator: 4 });
  return doc;
}

/** Publishing three-fifths: 52 * 5 = 260 < 177 * 3 = 531, so accumulation runs on to Good. */
function threeFifthsQuantileDocument(): Record<string, Json> {
  const doc = mjElection();
  doc["majority_judgment"] = mjBlock(2, "52", "0", { numerator: 3, denominator: 5 });
  return doc;
}

test("an MJ document is recomputed at the fraction IT publishes, not at three-fifths", async () => {
  const doc = quarterQuantileDocument();
  const outcome = await verifyTallyDocument(doc, tallyHash(doc), scenarioGateway(), XRD);
  assert.deepEqual(
    outcome,
    { kind: "match", hashChecked: true },
    "the grades settle at one-quarter because that is the fraction the document states — a " +
      "verifier applying a hardcoded three-fifths would call this correct document a lie",
  );
});

test("the same ballots under three-fifths settle two grades lower, and that also verifies", async () => {
  const doc = threeFifthsQuantileDocument();
  const outcome = await verifyTallyDocument(doc, tallyHash(doc), scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("changing only the published fraction makes the published grades wrong", async () => {
  // The one-quarter document with its fraction swapped for three-fifths and NOTHING else
  // touched. If the field were decoration both would verify; because it is the input to the
  // recomputation, the grades it published are now the grades of a different rule.
  const doc = quarterQuantileDocument();
  (doc["majority_judgment"] as Record<string, Json>)["grade_quantile"] = {
    numerator: 3,
    denominator: 5,
  };
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const fields = outcome.differences.map((d) => d.field);
  assert.deepEqual(fields, ["majority_judgment"], `got ${JSON.stringify(fields)}`);
  assert.match(outcome.differences[0]?.recomputed ?? "", /"qualifying_grade":2/);
});

test("a v14 MJ document publishing no fraction still verifies, under three-fifths", async () => {
  // The field arrived in v15. Refusing a document that predates it, or recomputing it under a
  // quantile it never claimed, would break every election settled before the field existed.
  const doc = mjElection();
  doc["tally_doc_version"] = 14;
  delete doc["excluded_accounts"];
  doc["majority_judgment"] = mjBlock(2, "52", "0", null);
  assert.equal(
    "grade_quantile" in (doc["majority_judgment"] as Record<string, Json>),
    false,
    "the fixture must really be the old field set",
  );
  const outcome = await verifyTallyDocument(doc, tallyHash(doc), scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("a Grade Quantile written as a decimal is MALFORMED, not rounded into shape", async () => {
  // The whole reason the framework specifies a numerator and a denominator is that 0.6 has no
  // exact binary representation. A verifier willing to read one is willing to disagree with the
  // ledger in the last place.
  const doc = quarterQuantileDocument();
  (doc["majority_judgment"] as Record<string, Json>)["grade_quantile"] = 0.6 as unknown as Json;
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "malformed");
  if (outcome.kind === "malformed") assert.match(outcome.reason, /grade_quantile/);
});

/* ------------------------------------------------------------------------------------------
 * Invalid MJ ballots and Participation, end to end (v15).
 *
 * A weighs 125 and casts a ballot grading one of the two candidates — invalid, not partial. Its
 * weight reaches nothing, so the election is left with B's 52 against an unchanged quorum of
 * 100 and misses it. Before v15 that 125 sat in `total_weight` and carried the quorum without a
 * single valid grade behind it.
 * ---------------------------------------------------------------------------------------- */

/** The same election with A's ballot malformed: one grade for a two-candidate contest. */
function invalidBallotDocument(): Record<string, Json> {
  const doc = mjElection();
  doc["votes"] = [
    { account: ACCOUNT_A, selection: [2], weight: "125" },
    { account: ACCOUNT_B, selection: [0, 5], weight: "52" },
  ];
  doc["totals"] = ["52", "0", "0", "0", "0", "52", "0", "0", "0", "0"];
  doc["total_weight"] = "52";
  doc["voter_count"] = 1;
  doc["min_unique_voters"] = 1;
  doc["quorum_met"] = false;
  doc["winners"] = null;
  doc["majority_judgment"] = null; // no quorum, no allocation, nothing to report
  return doc;
}

test("an invalid MJ ballot is absent from Participation, and the election misses quorum", async () => {
  const doc = invalidBallotDocument();
  const outcome = await verifyTallyDocument(doc, tallyHash(doc), scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("publishing an invalid ballot's weight as Participation is FIGURES", async () => {
  // The pre-v15 answer over exactly the same ballots: A's 125 in total_weight, A counted as a
  // voter, and the quorum met on the strength of a ballot that graded nobody.
  const doc = invalidBallotDocument();
  doc["total_weight"] = "177";
  doc["voter_count"] = 2;
  doc["quorum_met"] = true;
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const fields = outcome.differences.map((d) => d.field);
  for (const expected of ["total_weight", "voter_count", "quorum_met"]) {
    assert.ok(fields.includes(expected), `${expected} must differ, got ${JSON.stringify(fields)}`);
  }
});

test("a v14 document still hashes to the bytes it always did", async () => {
  // Pinned, not recomputed from the fixture: the point is that adding v15's field did not move
  // the canonical form of a document that does not carry it. If this constant has to change,
  // every tally published before the bar has stopped verifying.
  assert.equal(
    tallyHash(v14Document()),
    "f2a3556fb7ef45d7b71b69c02c230f5ae90d961c5fe8eca619f26f4558a0f022",
    "the canonical bytes of this exact document under the code as it stood before v15",
  );
  // And the figures still recompute against it, so the hash above is a hash of a VALID document
  // rather than of whatever this fixture drifted into.
  const outcome = await verifyTallyDocument(v14Document(), null, scenarioGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: false });
});
