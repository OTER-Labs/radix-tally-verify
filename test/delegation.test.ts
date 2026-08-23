/**
 * The DELEGATION leg (tally document v18).
 *
 * Two things are tested here, and they are different in kind:
 *
 *   - **the resolution**, which decides whether each delegation in force moved any weight and
 *     publishes WHY it did not — a pure function of the snapshot input, who voted, and the bar;
 *   - **what an effective delegation does to the tally**, which is the part where a rule that
 *     resolves correctly can still be wired into the aggregates wrongly.
 *
 * The second is the reason the tests below pin each aggregate separately rather than asserting
 * one composite. The failure this leg invites is an implementation that remembers to add
 * delegated weight to the option totals and forgets `abstain_weight`, or adds it to both and
 * also increments `voter_count` — which would let one delegate count as many voters and defeat
 * the unique-voter floor.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Dec } from "../src/decimal.ts";
import {
  counted,
  delegatedWeightByDelegate,
  resolveDelegations,
} from "../src/delegation.ts";
import type { SnapshotDelegation } from "../src/delegation.ts";
import { GRADES, deriveFigures } from "../src/verdict.ts";
import type { VerdictSpec } from "../src/verdict.ts";

const d = (n: number): Dec => Dec.fromInt(BigInt(n));
const A = "account_rdx1aaa";
const B = "account_rdx1bbb";
const C = "account_rdx1ccc";
const DAO = "account_rdx1dao_controlled";

const del = (
  delegator: string,
  delegate: string,
  delegateDeclined = false,
): SnapshotDelegation => ({ delegator, delegate, delegateDeclined });

const reasons = (
  snapshot: SnapshotDelegation[],
  voted: string[],
  barred: string[] = [],
): Array<string | null> =>
  resolveDelegations(snapshot, new Set(voted), new Set(barred)).map((r) => r.refusal);

/* ---- the resolution ------------------------------------------------------- */

test("an effective delegation is one where every condition holds", () => {
  assert.deepEqual(reasons([del(A, B)], [B]), [null]);
});

test("each refusal reason is reported, and the bar is reported ahead of every other", () => {
  // The delegator's funds are the DAO's: charter §5, and THE laundering block. Without this,
  // delegation re-enfranchises exactly the balances the bar removes.
  assert.deepEqual(reasons([del(DAO, B)], [B], [DAO]), ["excluded_delegator"]);

  // An account cannot cast its own weight twice.
  assert.deepEqual(reasons([del(A, A)], [A]), ["self_delegation"]);

  // A direct ballot revokes the standing instruction for the vote it is cast in.
  assert.deepEqual(reasons([del(A, B)], [A, B]), ["delegator_voted"]);

  // The delegate had refused incoming delegated weight as of the snapshot.
  assert.deepEqual(reasons([del(A, B, true)], [B]), ["delegate_declined"]);

  // The delegate is itself barred, so its ballot is not a vote and there is nothing for the
  // weight to attach to.
  assert.deepEqual(reasons([del(A, DAO)], [DAO], [DAO]), ["excluded_delegate"]);

  // The delegate cast no ballot. The weight is cast by NOBODY; it does not fall back.
  assert.deepEqual(reasons([del(A, B)], []), ["delegate_did_not_vote"]);

  // Order decides only which reason is REPORTED, never the outcome — but the reported reason is
  // what a reader checks, so when the DAO's own funds are involved that is the fact published,
  // whatever else is also true of the record. Here the delegator is barred AND voted AND the
  // delegate declined; the bar is what comes out.
  assert.deepEqual(reasons([del(DAO, B, true)], [DAO, B], [DAO]), ["excluded_delegator"]);
});

test("an empty ballot revokes, exactly as a filled one does", () => {
  // Showing up to abstain is showing up. The opposite rule would let an account carry a
  // consultation toward quorum itself AND hand the same weight to a delegate.
  const spec = bindingSpec();
  const f = deriveFigures(
    { ...spec, delegationInput: [del(A, B)] },
    [
      { account: A, selection: [] },
      { account: B, selection: [1] },
    ],
    new Map([
      [A, d(40)],
      [B, d(60)],
    ]),
  );
  assert.deepEqual(f.delegations?.map((r) => r.refusal), ["delegator_voted"]);
  assert.equal(f.delegatedWeightTotal?.toString(), "0");
  assert.equal(f.abstainWeight.toString(), "40", "A's own weight abstains, on A's own ballot");
  assert.equal(f.totals[1]?.toString(), "60", "and B carries only its own");
});

test("delegation is one hop and never transitive, and a ring is a non-event", () => {
  // A→B→C: A's weight is available to B and stops there. It does not reach C.
  const chain = resolveDelegations([del(A, B), del(B, C)], new Set([C]), new Set());
  assert.deepEqual(chain.map((r) => r.refusal), ["delegate_did_not_vote", null]);
  const { byDelegate, total } = delegatedWeightByDelegate(
    chain,
    new Map([
      [A, d(10)],
      [B, d(20)],
    ]),
  );
  assert.equal(byDelegate.get(C)?.toString(), "20", "C carries B's weight");
  assert.equal(byDelegate.get(B), undefined, "and B carries nothing, having cast no ballot");
  assert.equal(total.toString(), "20", "A's 10 is cast by nobody, and does not fall back to A");

  // A ring A→B→A resolves with no special handling, because there is no traversal to terminate.
  // If only B voted, B carries A's weight and A's alone.
  const ring = resolveDelegations([del(A, B), del(B, A)], new Set([B]), new Set());
  assert.deepEqual(ring.map((r) => r.refusal), [null, "delegator_voted"]);
  const ringWeights = delegatedWeightByDelegate(ring, new Map([[A, d(10)], [B, d(20)]]));
  assert.equal(ringWeights.byDelegate.get(B)?.toString(), "10");
  assert.equal(ringWeights.total.toString(), "10");

  // If NEITHER voted, nothing is cast at all.
  const dormant = resolveDelegations([del(A, B), del(B, A)], new Set(), new Set());
  assert.ok(dormant.every((r) => !counted(r)));
});

/* ---- what an effective delegation does to the tally ----------------------- */

function bindingSpec(over: Partial<VerdictSpec> = {}): VerdictSpec {
  return {
    kind: "Binding",
    optionCount: 2,
    seats: 0,
    seatRule: null,
    quorum: d(1),
    approvalThresholdPc: d(50),
    minAffirmativeSupport: d(0),
    minUniqueVoters: 0,
    excluded: [],
    excludedAccounts: [],
    gradeQuantile: null,
    delegationInput: null,
    tallyDocVersion: 20,
    ...over,
  };
}

test("an effective delegation rides the ballot into every total, but not into voter_count", () => {
  const f = deriveFigures(
    bindingSpec({ delegationInput: [del(A, B), del(C, B)] }),
    [{ account: B, selection: [1] }],
    new Map([
      [A, d(30)],
      [B, d(10)],
      [C, d(20)],
    ]),
  );
  assert.equal(f.totals[1]?.toString(), "60", "10 own + 30 + 20 delegated reaches the option");
  assert.equal(f.totalWeight.toString(), "60", "and total_weight, and therefore quorum");
  assert.equal(
    f.voterCount,
    1,
    "a delegate is ONE voter however many accounts delegated to them — the unique-voter floor " +
      "counts the accounts that turned up, and delegation moves weight, not people",
  );
  assert.equal(f.delegatedWeightTotal?.toString(), "50");
  assert.equal(f.voteDelegatedWeight[0]?.toString(), "50");
  assert.equal(f.voteEffectiveWeight[0]?.toString(), "60");
  assert.equal(
    f.weights.get(B)?.toString(),
    "10",
    "the delegate's OWN weight is untouched — publishing the combined figure under that name " +
      "would re-read a delegator's balance as the delegate's on the next run",
  );
});

test("delegated weight follows an EMPTY delegate ballot into abstain_weight", () => {
  const f = deriveFigures(
    bindingSpec({ delegationInput: [del(A, B)] }),
    [{ account: B, selection: [] }],
    new Map([
      [A, d(30)],
      [B, d(10)],
    ]),
  );
  assert.equal(f.abstainWeight.toString(), "40", "an effective delegation shares the ballot's fate");
  assert.equal(f.totalWeight.toString(), "40");
  assert.equal(f.totals[0]?.toString(), "0");
  assert.equal(f.totals[1]?.toString(), "0");
});

test("the bar follows the balance through delegation, and blocks it in both roles", () => {
  // As DELEGATOR: the DAO's weight does not reach a vote through a delegate. This is the whole
  // laundering defence, and it is enforced on the graph BEFORE resolution rather than on the
  // totals afterwards.
  const asDelegator = deriveFigures(
    bindingSpec({ excludedAccounts: [DAO], delegationInput: [del(DAO, B)] }),
    [{ account: B, selection: [1] }],
    new Map([
      [DAO, d(1000)],
      [B, d(10)],
    ]),
  );
  assert.equal(asDelegator.totals[1]?.toString(), "10", "the barred balance reaches nothing");
  assert.equal(asDelegator.delegatedWeightTotal?.toString(), "0");
  assert.deepEqual(asDelegator.delegations?.map((r) => r.refusal), ["excluded_delegator"]);

  // As DELEGATE: a barred account named as a delegate receives nothing, because its own ballot
  // is not a vote. The delegator's weight is cast by nobody and does not fall back.
  const asDelegate = deriveFigures(
    bindingSpec({ excludedAccounts: [DAO], delegationInput: [del(A, DAO)] }),
    [{ account: DAO, selection: [1] }],
    new Map([
      [A, d(50)],
      [DAO, d(10)],
    ]),
  );
  assert.equal(asDelegate.totals[1]?.toString(), "0");
  assert.equal(asDelegate.voterCount, 0);
  assert.deepEqual(asDelegate.voteExcluded, [true]);
  assert.equal(
    asDelegate.voteDelegatedWeight[0],
    null,
    "no delegation figures on a barred ballot: printing a zero would suggest nobody had tried",
  );
});

test("an MJ-invalid delegate ballot takes the delegated weight down with it", () => {
  // An effective delegation shares the fate of the ballot it attached to. A ballot that
  // Majority Judgment rules invalid counts toward nothing, and neither does what was delegated
  // to it — otherwise spoiling would be a way to park weight in the quorum without grading.
  const spec: VerdictSpec = {
    kind: "Election",
    optionCount: 2 * GRADES.length,
    seats: 1,
    seatRule: "MajorityJudgment",
    quorum: d(1),
    approvalThresholdPc: d(0),
    minAffirmativeSupport: d(0),
    minUniqueVoters: 0,
    excluded: [],
    excludedAccounts: [],
    gradeQuantile: null,
    delegationInput: [del(A, B)],
    tallyDocVersion: 20,
  };
  // B grades only candidate 0 — not every candidate exactly once, so the ballot is invalid.
  const f = deriveFigures(
    spec,
    [{ account: B, selection: [0] }],
    new Map([
      [A, d(500)],
      [B, d(10)],
    ]),
  );
  assert.equal(f.totalWeight.toString(), "0", "neither own nor delegated weight is Participation");
  assert.equal(f.voterCount, 0);
  assert.equal(
    f.delegatedWeightTotal?.toString(),
    "500",
    "the delegation still COUNTED — it attached to a ballot; the ballot is what failed",
  );
});

test("the leg being off is a different claim from nobody having delegated", () => {
  const off = deriveFigures(
    bindingSpec({ delegationInput: null }),
    [{ account: B, selection: [1] }],
    new Map([[B, d(10)]]),
  );
  assert.equal(off.delegations, null, "null: the leg was not in force for this consultation");
  assert.equal(off.delegatedWeightTotal, null);
  assert.equal(off.voteDelegatedWeight[0], null, "and no per-ballot split is published");

  const onButEmpty = deriveFigures(
    bindingSpec({ delegationInput: [] }),
    [{ account: B, selection: [1] }],
    new Map([[B, d(10)]]),
  );
  assert.deepEqual(onButEmpty.delegations, [], "[]: it was in force, and nobody had delegated");
  assert.equal(onButEmpty.delegatedWeightTotal?.toString(), "0");
  assert.equal(onButEmpty.voteDelegatedWeight[0]?.toString(), "0");
});
