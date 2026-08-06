/**
 * Verdict re-derivation. These are the reference engine's own test cases restated against
 * this implementation — the two agreeing on the awkward cases (exact-quantile qualifying
 * grades, residual ties at the seat boundary, a withdrawn front-runner) is what makes the
 * re-derivation worth trusting. No Gateway anywhere: ballots and weights come in as values.
 *
 * Majority Judgment settles at the Grade Quantile of THREE-FIFTHS of the weight cast, not the
 * median — the framework moved off the median on 2026-08-05 (Shadaffy/radix-dao-governance
 * b98269e). "MJ seam" below pins the one case where that matters: a top grade holding between
 * one half and three-fifths of the weight settled there under the old median and settles one
 * grade lower under three-fifths.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Dec } from "../src/decimal.ts";
import {
  GRADES,
  THREE_FIFTHS,
  allocateSeatsMajorityJudgment,
  allocateSeatsPlurality,
  allocateSeatsSpav,
  bindingApproved,
  deriveFigures,
} from "../src/verdict.ts";
import type { Ballot, DerivedFigures, GradeQuantile, VerdictSpec } from "../src/verdict.ts";

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

test("MJ: the qualifying grade is the highest grade reaching three-fifths of the cast weight", () => {
  let r = allocateSeatsMajorityJudgment([mj(60, [0]), mj(40, [4])], 1, 1, NONE);
  assert.equal(r.candidates[0]?.qualifying, 0, "60% Excellent reaches the three-fifths quantile exactly");
  r = allocateSeatsMajorityJudgment([mj(40, [0]), mj(60, [4])], 1, 1, NONE);
  assert.equal(r.candidates[0]?.qualifying, 4, "40% Excellent does not reach three-fifths");
});

test("MJ: exactly the Grade Quantile resolves upward", () => {
  const r = allocateSeatsMajorityJudgment([mj(60, [1]), mj(40, [3])], 1, 1, NONE);
  assert.equal(
    r.candidates[0]?.qualifying,
    1,
    "60 of 100 is exactly three-fifths; it takes Very Good, not Acceptable — the comparison " +
      "never divides, so landing exactly on the quantile resolves upward exactly",
  );
});

test("MJ seam: between one-half and three-fifths settles one grade lower under the Grade " +
  "Quantile than it would have under the old median", () => {
  // 55% of the weight cast graded this candidate Very Good, the rest Good. Under the median
  // (threshold 50%) 55 >= 50 qualifies at Very Good. Under three-fifths (threshold 60%) 55 < 60,
  // so accumulation continues to the next grade, where all 100% crosses — Good, one full grade
  // lower, off the exact same ballots. This is the entire behavioural difference the 2026-08-05
  // framework change makes.
  const r = allocateSeatsMajorityJudgment([mj(55, [1]), mj(45, [2])], 1, 1, NONE);
  assert.equal(
    r.candidates[0]?.qualifying,
    2,
    "three-fifths of 100 is 60; 55 does not reach it (the old median's 50 threshold would have), " +
      "so the qualifying grade falls to Good instead of Very Good",
  );
});

test("MJ: a qualifying grade below Good is not seatable and the seat stays empty", () => {
  const r = allocateSeatsMajorityJudgment([mj(100, [3, 2])], 2, 2, NONE);
  assert.equal(r.candidates[0]?.qualifying, 3);
  assert.equal(r.candidates[1]?.qualifying, 2);
  assert.deepEqual(r.winners, [1], "only the candidate at or above Good is seated");
});

test("MJ: the gauge orders by sign before magnitude", () => {
  const ballots = [mj(30, [0, 0, 2]), mj(40, [2, 2, 2]), mj(30, [2, 4, 4])];
  const r = allocateSeatsMajorityJudgment(ballots, 3, 3, NONE);
  for (const c of r.candidates) assert.equal(c.qualifying, 2);
  assert.deepEqual(r.winners, [0, 1, 2], "p>q, then p==q, then p<q");
});

test("MJ: within a gauge class p descends and q ascends", () => {
  let r = allocateSeatsMajorityJudgment([mj(20, [0, 0]), mj(20, [0, 2]), mj(60, [2, 2])], 2, 2, NONE);
  assert.deepEqual(r.winners, [0, 1], "higher p wins inside p>q");
  // Both candidates qualify at Good with 60/80 of 100 (>= three-fifths); candidate 1's below-Good
  // weight (q=20) is lower than candidate 0's (q=40), so it ranks first within the p<q class.
  r = allocateSeatsMajorityJudgment([mj(60, [2, 2]), mj(20, [4, 2]), mj(20, [4, 4])], 2, 2, NONE);
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
  assert.equal(r.candidates[0]?.qualifying, 0, "the grades remain a fact about the electorate");
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
    excludedAccounts: [],
    gradeQuantile: null,
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
    excludedAccounts: [],
    gradeQuantile: null,
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

/**
 * The DAO-controlled-funds bar (framework 47ceb27, charter §5): "No balance in an account the
 * DAO controls may be voted, delegated, or used to file or support any governance action."
 *
 * The barred ballot stays in the document — that is what makes the exclusion checkable — but it
 * is NOT A VOTE. The tests below pin each aggregate separately rather than one composite
 * assertion, because the failure mode this rule invites is an implementation that remembers the
 * option totals and forgets `abstain_weight`, or remembers both and still counts the voter.
 */

const DAO = "account_rdx1dao_controlled";

/** A Binding spec over a two-option ballot, with whatever the test wants to vary. */
function bindingSpec(over: Partial<VerdictSpec> = {}): VerdictSpec {
  return {
    kind: "Binding",
    optionCount: 2,
    seats: 0,
    seatRule: null,
    quorum: d(100),
    approvalThresholdPc: d(50),
    minAffirmativeSupport: d(10),
    minUniqueVoters: 1,
    excluded: [],
    excludedAccounts: [],
    gradeQuantile: null,
    ...over,
  };
}

test("a barred ballot reaches no aggregate at all — it is the account that did not vote", () => {
  const votes = [
    { account: DAO, selection: [1] },
    { account: "a", selection: [1] },
    { account: "b", selection: [0] },
  ];
  const weights = new Map([
    [DAO, d(1000)],
    ["a", d(60)],
    ["b", d(50)],
  ]);

  const counted = deriveFigures(bindingSpec(), votes, weights);
  assert.equal(counted.totals[1]?.toString(), "1060", "control: unbarred, the DAO's weight lands");

  const f = deriveFigures(bindingSpec({ excludedAccounts: [DAO] }), votes, weights);
  assert.equal(f.totals[0]?.toString(), "50", "no option total");
  assert.equal(f.totals[1]?.toString(), "60", "not even the option it selected");
  assert.equal(f.totalWeight.toString(), "110", "not total_weight");
  assert.equal(f.abstainWeight.toString(), "0", "not abstain_weight");
  assert.equal(f.voterCount, 2, "not voter_count — three ballots, two voters");
  assert.deepEqual(f.voteExcluded, [true, false, false], "and the bar is reported per ballot");
  // The same figures as a tally where the DAO simply never voted.
  const absent = deriveFigures(bindingSpec(), votes.slice(1), weights);
  assert.equal(f.totals[1]?.toString(), absent.totals[1]?.toString());
  assert.equal(f.totalWeight.toString(), absent.totalWeight.toString());
  assert.equal(f.voterCount, absent.voterCount);
});

test("dropping the barred ballot can lose quorum, and the threshold does not move to save it", () => {
  // The DAO holds 1000 of the 1060 cast. Barred, 60 is left against a quorum of 100.
  const votes = [
    { account: DAO, selection: [1] },
    { account: "a", selection: [1] },
  ];
  const weights = new Map([
    [DAO, d(1000)],
    ["a", d(60)],
  ]);
  const spec = bindingSpec({ excludedAccounts: [DAO] });

  assert.equal(deriveFigures(bindingSpec(), votes, weights).quorumMet, true, "control: 1060 >= 100");

  const f = deriveFigures(spec, votes, weights);
  assert.equal(
    f.quorumMet,
    false,
    "60 < the stated quorum of 100. An implementation that rescaled the quorum to the " +
      "unbarred electorate would pass here — the framework says the bar 'determines who may " +
      "vote; it does not change how quorum is measured'",
  );
  assert.equal(f.approved, false, "and no quorum is no approval, whatever the ratio says");
  // The quorum that IS applied is the document's own, unaltered: 60 clears a stated 60.
  assert.equal(
    deriveFigures(bindingSpec({ excludedAccounts: [DAO], quorum: d(60) }), votes, weights).quorumMet,
    true,
    "a floor reached is a floor met — the figure compared against is the one the document states",
  );
});

test("the barred ballot is not a voter, so the unique-voter leg can fail on its own", () => {
  const votes = [
    { account: DAO, selection: [1] },
    { account: "a", selection: [1] },
  ];
  const weights = new Map([
    [DAO, d(10)],
    ["a", d(500)],
  ]);
  const spec = bindingSpec({ excludedAccounts: [DAO], minUniqueVoters: 2 });
  const f = deriveFigures(spec, votes, weights);
  assert.equal(f.totalWeight.toString(), "500", "weight enough on its own");
  assert.equal(f.voterCount, 1);
  assert.equal(f.quorumMet, false, "one voter against a floor of two — both legs are required");
});

test("a barred EMPTY selection is not an abstention: it abstains from nothing", () => {
  const votes = [
    { account: DAO, selection: [] },
    { account: "a", selection: [1] },
  ];
  const weights = new Map([
    [DAO, d(1000)],
    ["a", d(200)],
  ]);
  assert.equal(
    deriveFigures(bindingSpec(), votes, weights).abstainWeight.toString(),
    "1000",
    "control: unbarred, an empty selection IS an abstention",
  );
  const f = deriveFigures(bindingSpec({ excludedAccounts: [DAO] }), votes, weights);
  assert.equal(f.abstainWeight.toString(), "0", "barred, it is not one");
  assert.equal(f.totalWeight.toString(), "200", "abstaining weight counts toward quorum — this does not");
});

/** The recomputed `majority_judgment` block, typed enough to assert against. */
interface MjBlock {
  candidates: Array<{ by_grade: string[]; cast: string; qualifying_grade: number | null }>;
  invalid_ballots: number[];
  grade_quantile?: GradeQuantile;
}

function mjBlock(f: DerivedFigures): MjBlock {
  return f.majorityJudgment as unknown as MjBlock;
}

const mjSpec = (candidates: number, over: Partial<VerdictSpec> = {}): VerdictSpec => ({
  kind: "Election",
  optionCount: candidates * GRADES.length,
  seats: candidates,
  seatRule: "MajorityJudgment",
  quorum: d(100),
  approvalThresholdPc: d(0),
  minAffirmativeSupport: d(0),
  minUniqueVoters: 0,
  excluded: [],
  excludedAccounts: [],
  gradeQuantile: null,
  ...over,
});

test("MJ: a barred ballot's grades are absent from by_grade and from cast", () => {
  // The DAO grades both candidates Excellent with ten times everyone else's weight. Counted, it
  // decides the grade distribution outright; barred, it must not appear in it anywhere.
  const grades = (g: number[]): number[] => g.map((x, c) => c * GRADES.length + x);
  const votes = [
    { account: DAO, selection: grades([0, 0]) },
    { account: "a", selection: grades([2, 2]) },
    { account: "b", selection: grades([2, 2]) },
  ];
  const weights = new Map([
    [DAO, d(1000)],
    ["a", d(60)],
    ["b", d(40)],
  ]);

  const counted = mjBlock(deriveFigures(mjSpec(2), votes, weights));
  assert.equal(counted.candidates[0]?.cast, "1100", "control: cast includes the DAO");
  assert.equal(counted.candidates[0]?.by_grade[0], "1000", "control: its Excellent weight is there");
  assert.equal(counted.candidates[0]?.qualifying_grade, 0, "control: and it sets the qualifying grade");

  const f = deriveFigures(mjSpec(2, { excludedAccounts: [DAO] }), votes, weights);
  const mjb = mjBlock(f);
  for (const c of mjb.candidates) {
    assert.deepEqual(c.by_grade, ["0", "0", "100", "0", "0"], "no barred weight in any grade bucket");
    assert.equal(c.cast, "100", "cast is the weight that actually graded the candidate");
    assert.equal(c.qualifying_grade, 2, "Good, not the Excellent the barred ballot would have bought");
  }
  assert.deepEqual(f.winners, [0, 1]);
  assert.deepEqual(mjb.invalid_ballots, []);
});

test("MJ: invalid_ballots keeps indexing the document's votes, not the surviving subset", () => {
  // The barred ballot sits at index 0. The malformed one at index 1 must still be reported as 1
  // — renumbering it to 0 would point the report at the wrong voter, and at a voter whose ballot
  // was not even counted.
  const votes = [
    { account: DAO, selection: [0, GRADES.length] }, // a complete, valid MJ ballot
    { account: "x", selection: [0] }, // one grade for two candidates: invalid
    { account: "y", selection: [2, GRADES.length + 2] },
  ];
  const weights = new Map([
    [DAO, d(1000)],
    ["x", d(10)],
    ["y", d(100)],
  ]);
  const f = deriveFigures(mjSpec(2, { excludedAccounts: [DAO], quorum: d(0) }), votes, weights);
  assert.deepEqual(
    mjBlock(f).invalid_ballots,
    [1],
    "the malformed ballot keeps its position in `votes`",
  );
});

/* ------------------------------------------------------------------------------------------
 * The published Grade Quantile (v15, Proposal & Voting Framework §6.5).
 *
 * Every MJ result now states the exact fraction it was settled at, and the recomputation uses
 * THAT fraction rather than whatever this verifier believes today. The point of the field is
 * that a stored result stays recomputable under the rule that produced it: this engine has
 * already moved the quantile once (median -> three-fifths, 2026-08-05), and a verifier
 * hardcoding the current value would call every document written under the old one a lie.
 * ---------------------------------------------------------------------------------------- */

const ONE_HALF: GradeQuantile = { numerator: 1, denominator: 2 };

test("MJ: the qualifying grade settles at the quantile it is given, not at a hardcoded one", () => {
  // The seam ballots: 55% of the weight cast grades this candidate Very Good, 45% Good.
  const ballots = [mj(55, [1]), mj(45, [2])];
  assert.equal(
    allocateSeatsMajorityJudgment(ballots, 1, 1, NONE, THREE_FIFTHS).candidates[0]?.qualifying,
    2,
    "three-fifths of 100 is 60; 55 does not reach it, so the grade falls to Good",
  );
  assert.equal(
    allocateSeatsMajorityJudgment(ballots, 1, 1, NONE, ONE_HALF).candidates[0]?.qualifying,
    1,
    "one-half of 100 is 50; 55 clears it, and the SAME ballots settle at Very Good",
  );
});

test("MJ: the recomputation uses the document's published fraction, not three-fifths", () => {
  // Identical ballots, identical weights, one difference: the fraction the document says it was
  // settled at. If this verifier ignored the field, both halves would produce the same grade —
  // and the whole of §6.5 would be decoration.
  const grades = (g: number[]): number[] => g.map((x, c) => c * GRADES.length + x);
  const votes = [
    { account: "a", selection: grades([1]) }, // Very Good
    { account: "b", selection: grades([2]) }, // Good
  ];
  const weights = new Map([
    ["a", d(55)],
    ["b", d(45)],
  ]);

  const underThreeFifths = mjBlock(deriveFigures(mjSpec(1), votes, weights));
  assert.equal(underThreeFifths.candidates[0]?.qualifying_grade, 2, "a document publishing 3/5");

  const underOneHalf = mjBlock(
    deriveFigures(mjSpec(1, { gradeQuantile: ONE_HALF }), votes, weights),
  );
  assert.equal(
    underOneHalf.candidates[0]?.qualifying_grade,
    1,
    "a document publishing 1/2 settles one grade HIGHER off the same ballots — which it can " +
      "only do if the published fraction is what was applied",
  );
});

test("the published fraction is echoed back exactly, so it is checkable rather than assumed", () => {
  const grades = (g: number[]): number[] => g.map((x, c) => c * GRADES.length + x);
  const votes = [{ account: "a", selection: grades([0]) }];
  const weights = new Map([["a", d(200)]]);

  const published = mjBlock(deriveFigures(mjSpec(1, { gradeQuantile: ONE_HALF }), votes, weights));
  assert.deepEqual(
    published.grade_quantile,
    { numerator: 1, denominator: 2 },
    "an exact fraction, never a decimal — 0.6 has no exact binary representation and the " +
      "comparison cross-multiplies",
  );

  // A document that publishes no fraction gets none back. The block is compared structurally,
  // so inventing the field here would report every pre-v15 election as a figure difference.
  const absent = mjBlock(deriveFigures(mjSpec(1), votes, weights));
  assert.equal(
    "grade_quantile" in absent,
    false,
    "a v14 document carries no such field, and neither may its recomputation",
  );
});

test("a document with no published fraction falls back to three-fifths", () => {
  // v14 and earlier. Absent is not a licence to pick a quantile: it pins the recomputation to
  // the one the engine of that vintage applied, which is three-fifths.
  const grades = (g: number[]): number[] => g.map((x, c) => c * GRADES.length + x);
  const votes = [
    { account: "a", selection: grades([1]) },
    { account: "b", selection: grades([2]) },
  ];
  const weights = new Map([
    ["a", d(55)],
    ["b", d(45)],
  ]);
  const f = deriveFigures(mjSpec(1, { gradeQuantile: null }), votes, weights);
  assert.equal(
    mjBlock(f).candidates[0]?.qualifying_grade,
    2,
    "55 of 100 does not reach three-fifths, so Good — the same answer the pre-v15 engine gave",
  );
  assert.deepEqual(
    mjBlock(f).candidates[0]?.qualifying_grade,
    mjBlock(deriveFigures(mjSpec(1, { gradeQuantile: THREE_FIFTHS }), votes, weights))
      .candidates[0]?.qualifying_grade,
    "absent and an explicit three-fifths settle identically; only the echoed field differs",
  );
});

/* ------------------------------------------------------------------------------------------
 * Invalid Majority Judgment ballots and Participation (v15; On-Chain Identifiers &
 * Verification Policy §4, Proposal & Voting Framework §6.3).
 *
 * A ballot that does not grade every candidate exactly once is INVALID rather than partial, and
 * Participation is the total power of VALID ballots only. Its weight reaches nothing: no option
 * total, no total_weight, no abstain_weight, no voter_count, no grade. Before v15 it counted
 * toward total_weight and therefore toward quorum, which let a malformed ballot carry an
 * election over its quorum without expressing a single grade.
 * ---------------------------------------------------------------------------------------- */

test("an invalid MJ ballot reaches no aggregate — not even the option totals", () => {
  const grades = (g: number[]): number[] => g.map((x, c) => c * GRADES.length + x);
  const votes = [
    { account: "bad", selection: [0] }, // one grade for a two-candidate election: invalid
    { account: "a", selection: grades([2, 2]) },
  ];
  const weights = new Map([
    ["bad", d(1000)],
    ["a", d(60)],
  ]);

  const f = deriveFigures(mjSpec(2, { quorum: d(0) }), votes, weights);
  assert.equal(f.totalWeight.toString(), "60", "not total_weight");
  assert.equal(f.voterCount, 1, "not voter_count — two ballots, one voter");
  assert.equal(f.totals[0]?.toString(), "0", "not the option total its one index named");
  assert.equal(f.abstainWeight.toString(), "0", "and it is not an abstention either");
  for (const c of mjBlock(f).candidates) {
    assert.equal(c.cast, "60", "and no candidate's cast");
  }
  // It is still REPORTED, which is the difference between an invalid ballot and a barred one.
  assert.deepEqual(mjBlock(f).invalid_ballots, [0]);
});

test("excluding an invalid MJ ballot can lose the election its quorum", () => {
  // The malformed ballot holds 1000 of the 1060 that turned up. Counted toward Participation it
  // carries a quorum of 100 on its own, having graded nobody.
  const grades = (g: number[]): number[] => g.map((x, c) => c * GRADES.length + x);
  const votes = [
    { account: "bad", selection: [0, 1] }, // two grades for candidate 0, none for candidate 1
    { account: "a", selection: grades([2, 2]) },
  ];
  const weights = new Map([
    ["bad", d(1000)],
    ["a", d(60)],
  ]);
  const f = deriveFigures(mjSpec(2, { quorum: d(100) }), votes, weights);
  assert.equal(f.totalWeight.toString(), "60");
  assert.equal(
    f.quorumMet,
    false,
    "60 < the stated quorum of 100. Under the pre-v15 rule the malformed ballot's 1000 was in " +
      "total_weight and this election met its quorum without a single valid grade being cast",
  );
  assert.equal(f.winners, null, "and no quorum is no seats");
});

test("an empty MJ selection is invalid, so it is not the abstention it would be elsewhere", () => {
  // Approval voting treats an empty selection as an abstention that counts toward quorum. MJ has
  // no abstention: a ballot grading nobody leaves every candidate ungraded, which is invalid.
  const grades = (g: number[]): number[] => g.map((x, c) => c * GRADES.length + x);
  const votes = [
    { account: "empty", selection: [] },
    { account: "a", selection: grades([2]) },
  ];
  const weights = new Map([
    ["empty", d(500)],
    ["a", d(60)],
  ]);
  const f = deriveFigures(mjSpec(1, { quorum: d(0) }), votes, weights);
  assert.equal(f.abstainWeight.toString(), "0");
  assert.equal(f.totalWeight.toString(), "60");
  assert.deepEqual(mjBlock(f).invalid_ballots, [0]);
});

test("a barred ballot that is ALSO invalid appears in neither the aggregates nor invalid_ballots", () => {
  // The bar is applied first and the ballot never reaches the validity check. Reporting it as
  // invalid would accuse a voter of malformity on a ballot that was never eligible to be judged
  // — and would put an index into `invalid_ballots` that names an excluded ballot.
  const grades = (g: number[]): number[] => g.map((x, c) => c * GRADES.length + x);
  const votes = [
    { account: DAO, selection: [0] }, // barred AND malformed: one grade for two candidates
    { account: "a", selection: grades([2, 2]) },
  ];
  const weights = new Map([
    [DAO, d(1000)],
    ["a", d(60)],
  ]);

  const unbarred = deriveFigures(mjSpec(2, { quorum: d(0) }), votes, weights);
  assert.deepEqual(
    mjBlock(unbarred).invalid_ballots,
    [0],
    "control: not barred, the same malformed ballot IS reported invalid",
  );

  const f = deriveFigures(mjSpec(2, { excludedAccounts: [DAO], quorum: d(0) }), votes, weights);
  assert.deepEqual(f.voteExcluded, [true, false], "the bar is what is reported about it");
  assert.deepEqual(
    mjBlock(f).invalid_ballots,
    [],
    "and it is not ALSO reported invalid — the two exclusions are not cumulative",
  );
  assert.equal(f.totalWeight.toString(), "60", "absent from the aggregates either way");
  assert.equal(f.voterCount, 1);
  for (const c of mjBlock(f).candidates) assert.equal(c.cast, "60");
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
    excludedAccounts: [],
    gradeQuantile: null,
  };
  const votes = [{ account: "a", selection: [0, 1] }];
  const weights = new Map([["a", d(10)]]);
  const f = deriveFigures(spec, votes, weights);
  assert.equal(f.winners, null, "no winners, not 'the winners, but ignore them'");
});
