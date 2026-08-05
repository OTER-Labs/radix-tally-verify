/**
 * Verdict re-derivation. These are the reference engine's own test cases restated against
 * this implementation — the two agreeing on the awkward cases (exact-half medians, residual
 * ties at the seat boundary, a withdrawn front-runner) is what makes the re-derivation worth
 * trusting. No Gateway anywhere: ballots and weights come in as values.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Dec } from "../src/decimal.ts";
import {
  GRADES,
  allocateSeatsMajorityJudgment,
  allocateSeatsPlurality,
  allocateSeatsSpav,
  bindingApproved,
  deriveFigures,
} from "../src/verdict.ts";
import type { Ballot, VerdictSpec } from "../src/verdict.ts";

const d = (v: number): Dec => Dec.fromInt(BigInt(v));
const NONE: number[] = [];

const ballot = (weight: number, approvals: number[]): Ballot => ({
  weight: d(weight),
  selection: approvals,
});

/** A complete MJ ballot: one grade per candidate, encoded candidate * 5 + grade. */
const mj = (weight: number, grades: number[]): Ballot => ({
  weight: d(weight),
  selection: grades.map((g, c) => c * GRADES.length + g),
});

test("MAS blocks approval on a thin affirmative base", () => {
  // 100 approve, 0 reject (100% of decisive), quorum met — MAS 800 says no.
  assert.equal(bindingApproved(d(100), d(0), d(50), d(800), true), false);
  assert.equal(bindingApproved(d(800), d(0), d(50), d(800), true), true, "floor reached is floor met");
  assert.equal(bindingApproved(d(799), d(0), d(50), d(800), true), false);
});

test("MAS is a floor on top of the other gates, never a substitute", () => {
  assert.equal(bindingApproved(d(900), d(0), d(50), d(800), false), false, "quorum missed");
  assert.equal(bindingApproved(d(900), d(1100), d(50), d(800), true), false, "45% of decisive");
  assert.equal(bindingApproved(d(51), d(49), d(50), d(0), true), true, "strict majority passes");
  assert.equal(bindingApproved(d(50), d(50), d(50), d(0), true), false, "an exact tie fails");
});

test("plurality seats the highest totals and breaks ties to the lowest index", () => {
  assert.deepEqual(allocateSeatsPlurality([d(60), d(60), d(60), d(40)], 3, NONE), [0, 1, 2]);
  assert.deepEqual(allocateSeatsPlurality([d(10), d(10), d(10)], 2, NONE), [0, 1]);
});

test("plurality never seats zero support", () => {
  assert.deepEqual(allocateSeatsPlurality([d(5), d(0), d(0)], 3, NONE), [0]);
});

test("a withdrawn front-runner is replaced, not subtracted", () => {
  const totals = [d(28), d(18), d(10), d(4)];
  assert.deepEqual(allocateSeatsPlurality(totals, 3, NONE), [0, 1, 2], "control");
  assert.deepEqual(
    allocateSeatsPlurality(totals, 3, [0]),
    [1, 2, 3],
    "the vacated seat goes to the next candidate standing",
  );
});

test("SPAV stops a majority bloc from sweeping every seat", () => {
  const ballots = [ballot(60, [0, 1, 2]), ballot(40, [3])];
  const winners = allocateSeatsSpav(ballots, 4, 3, NONE);
  assert.ok(winners.includes(3), "the minority's candidate must take a seat");
  assert.equal(winners.length, 3);
  // Under plurality the same ballots sweep: totals are 60/60/60/40.
  assert.deepEqual(allocateSeatsPlurality([d(60), d(60), d(60), d(40)], 3, NONE), [0, 1, 2]);
});

test("SPAV skips the withdrawn without spending their voters", () => {
  const ballots = [ballot(60, [0, 1]), ballot(50, [2])];
  assert.deepEqual(allocateSeatsSpav(ballots, 3, 2, NONE), [0, 2], "control");
  assert.deepEqual(
    allocateSeatsSpav(ballots, 3, 2, [0]),
    [1, 2],
    "with 0 withdrawn its voters back 1 at full weight",
  );
});

test("zero-weight ballots cannot elect", () => {
  assert.deepEqual(allocateSeatsSpav([ballot(0, [0, 1])], 2, 2, NONE), []);
});

test("MJ: the median is the highest grade reaching half the cast weight", () => {
  let r = allocateSeatsMajorityJudgment([mj(60, [0]), mj(40, [4])], 1, 1, NONE);
  assert.equal(r.candidates[0]?.median, 0, "60% Excellent carries the median");
  r = allocateSeatsMajorityJudgment([mj(40, [0]), mj(60, [4])], 1, 1, NONE);
  assert.equal(r.candidates[0]?.median, 4, "40% Excellent does not reach half");
});

test("MJ: an exact half resolves upward", () => {
  const r = allocateSeatsMajorityJudgment([mj(50, [1]), mj(50, [3])], 1, 1, NONE);
  assert.equal(r.candidates[0]?.median, 1, "the even split takes Very Good, not Acceptable");
});

test("MJ: a median below Good is not seatable and the seat stays empty", () => {
  const r = allocateSeatsMajorityJudgment([mj(100, [3, 2])], 2, 2, NONE);
  assert.equal(r.candidates[0]?.median, 3);
  assert.equal(r.candidates[1]?.median, 2);
  assert.deepEqual(r.winners, [1], "only the candidate at or above Good is seated");
});

test("MJ: the gauge orders by sign before magnitude", () => {
  const ballots = [mj(30, [0, 0, 2]), mj(40, [2, 2, 2]), mj(30, [2, 4, 4])];
  const r = allocateSeatsMajorityJudgment(ballots, 3, 3, NONE);
  for (const c of r.candidates) assert.equal(c.median, 2);
  assert.deepEqual(r.winners, [0, 1, 2], "p>q, then p==q, then p<q");
});

test("MJ: within a gauge class p descends and q ascends", () => {
  let r = allocateSeatsMajorityJudgment([mj(20, [0, 0]), mj(20, [0, 2]), mj(60, [2, 2])], 2, 2, NONE);
  assert.deepEqual(r.winners, [0, 1], "higher p wins inside p>q");
  r = allocateSeatsMajorityJudgment([mj(50, [2, 2]), mj(30, [4, 2]), mj(20, [4, 4])], 2, 2, NONE);
  assert.deepEqual(r.winners, [1, 0], "lower q wins inside p<q");
});

test("MJ: a residual tie straddling the boundary seats nobody and refers", () => {
  const r = allocateSeatsMajorityJudgment([mj(70, [1, 1]), mj(30, [4, 4])], 2, 1, NONE);
  assert.deepEqual(r.winners, [], "the seat is left unfilled rather than decided by index");
  assert.deepEqual(r.referredTieUnresolved, [0, 1]);
});

test("MJ: a residual tie that fits inside the seats is seated whole", () => {
  const r = allocateSeatsMajorityJudgment([mj(70, [1, 1]), mj(30, [4, 4])], 2, 2, NONE);
  assert.deepEqual(r.winners, [0, 1]);
  assert.deepEqual(r.referredTieUnresolved, []);
});

test("MJ: incomplete and malformed ballots are invalid and reported", () => {
  const complete = mj(100, [0, 0, 0]);
  const short = { weight: d(50), selection: [0, 5] };
  const empty = { weight: d(50), selection: [] };
  const double = { weight: d(50), selection: [0, 1, 5] };
  const outOfRange = { weight: d(50), selection: [0, 5, 99] };
  const r = allocateSeatsMajorityJudgment([complete, short, empty, double, outOfRange], 3, 3, NONE);
  assert.deepEqual(r.invalidBallots, [1, 2, 3, 4]);
  assert.equal(r.candidates[0]?.cast.toString(), "100", "only the complete ballot was counted");
});

test("MJ: a withdrawn candidate is excluded from seating but still reported", () => {
  const ballots = [mj(60, [0, 1, 2]), mj(40, [0, 1, 2])];
  assert.deepEqual(allocateSeatsMajorityJudgment(ballots, 3, 2, NONE).winners, [0, 1], "control");
  const r = allocateSeatsMajorityJudgment(ballots, 3, 2, [0]);
  assert.deepEqual(r.winners, [1, 2], "the seat passes to the next candidate standing");
  assert.equal(r.candidates[0]?.median, 0, "the grades remain a fact about the electorate");
});

test("an abstention counts toward quorum and toward no option", () => {
  const spec: VerdictSpec = {
    kind: "Binding",
    optionCount: 2,
    seats: 0,
    seatRule: null,
    quorum: d(100),
    approvalThresholdPc: d(50),
    minAffirmativeSupport: d(10),
    minUniqueVoters: 0,
    excluded: [],
  };
  const votes = [
    { account: "a", selection: [] }, // abstains — carries the consultation over quorum
    { account: "b", selection: [1] },
  ];
  const weights = new Map([
    ["a", d(60)],
    ["b", d(50)],
  ]);
  const f = deriveFigures(spec, votes, weights);
  assert.equal(f.totalWeight.toString(), "110");
  assert.equal(f.abstainWeight.toString(), "60");
  assert.equal(f.quorumMet, true, "abstaining weight counts toward quorum");
  assert.equal(f.approved, true, "and the sole approving vote carries the decision");
});

test("quorum has two legs and both must hold", () => {
  const spec: VerdictSpec = {
    kind: "Poll",
    optionCount: 2,
    seats: 0,
    seatRule: null,
    quorum: d(100),
    approvalThresholdPc: d(0),
    minAffirmativeSupport: d(0),
    minUniqueVoters: 3,
    excluded: [],
  };
  const votes = [
    { account: "a", selection: [0] },
    { account: "b", selection: [0] },
  ];
  const weights = new Map([
    ["a", d(80)],
    ["b", d(80)],
  ]);
  const f = deriveFigures(spec, votes, weights);
  assert.equal(f.quorumMet, false, "weight enough, voters not — both legs are required");
});

test("a consultation that missed quorum seats nobody", () => {
  const spec: VerdictSpec = {
    kind: "Election",
    optionCount: 3,
    seats: 2,
    seatRule: "Plurality",
    quorum: d(1000),
    approvalThresholdPc: d(0),
    minAffirmativeSupport: d(0),
    minUniqueVoters: 0,
    excluded: [],
  };
  const votes = [{ account: "a", selection: [0, 1] }];
  const weights = new Map([["a", d(10)]]);
  const f = deriveFigures(spec, votes, weights);
  assert.equal(f.winners, null, "no winners, not 'the winners, but ignore them'");
});
