/**
 * Verdict re-derivation: apply the document's own stated rules to the recomputed weights and
 * see what outcome they produce.
 *
 * Every rule here is taken from the document itself — the quorum, threshold, MAS floor and
 * voter floor it states, and the seat rule it names. Nothing is assumed: the whole premise
 * of the tally document is that everything the verdict depends on travels with it, so a
 * verifier that hardcoded a rule would be checking its own assumptions, not the document.
 *
 * The arithmetic is scrypto Decimal throughout (src/decimal.ts), truncating division and all:
 * SPAV divides by an integer round count, and Majority Judgment's qualifying grade resolves
 * exactly on the boundary only because the comparison is a cross-multiplication, never a
 * division.
 *
 * The Grade Quantile that qualifying grade settles at is itself taken from the document — the
 * `majority_judgment.grade_quantile` fraction it publishes — and not from a constant here. A
 * stored result must be recomputable under the rule that PRODUCED it rather than under whatever
 * rule is current (Proposal & Voting Framework §6.5), and this engine has already moved the
 * quantile once (the median through to three-fifths, 2026-08-05). A verifier hardcoding today's
 * value would call every document written under yesterday's a lie.
 */

import { Dec } from "./decimal.ts";
import type { Json } from "./canonical.ts";

/** The five grades of the framework's scale, highest first. Ordinal 0 is Excellent, 4 is
 * Poor — the ordering is load-bearing, since "at or above grade g" is the whole qualifying
 * rule. */
export const GRADES = ["Excellent", "Very Good", "Good", "Acceptable", "Poor"] as const;

/** Lowest qualifying grade at which a candidate may be seated ("Good"). An ordinal, so the
 * comparison is `qualifying <= MINIMUM_QUALIFYING_GRADE` — lower ordinal is better. Unchanged
 * by the 2026-08-05 median -> three-fifths move: the floor is a grade, not a quantile. */
export const MINIMUM_QUALIFYING_GRADE = 2;

/**
 * The Grade Quantile a candidate's qualifying grade settles at, as an EXACT fraction.
 *
 * A numerator and a denominator, never a decimal: three-fifths is exact and 0.6 in binary
 * floating point is not, and the comparison the quantile describes
 * (`atOrAbove * denominator >= cast * numerator`) is one a challenger must reproduce without
 * ever dividing.
 */
export interface GradeQuantile {
  numerator: number;
  denominator: number;
}

/**
 * Three-fifths — the quantile the framework set on 2026-08-05
 * (Shadaffy/radix-dao-governance b98269e, which moved off the median and renamed "median grade"
 * to "qualifying grade").
 *
 * This is a FALLBACK, not the rule. Every document that publishes
 * `majority_judgment.grade_quantile` is recomputed under its own published fraction; this value
 * is used only for a document written before the field existed (v14 and earlier), where
 * three-fifths is what the engine of that vintage applied. It is deliberately not consulted
 * anywhere a published fraction is available.
 */
export const THREE_FIFTHS: GradeQuantile = { numerator: 3, denominator: 5 };

export interface Ballot {
  weight: Dec;
  selection: number[];
  /**
   * Where this ballot sits in the document's `votes` array, when that is not simply its position
   * in the ballot list. Majority Judgment reports `invalid_ballots` by index, and a barred ballot
   * is dropped before the tally — so without this the first exclusion would silently renumber
   * every invalid ballot after it, and the document's report would point at the wrong voters.
   */
  ballotIndex?: number;
}

/** Everything about the consultation the verdict needs, taken from the document. */
export interface VerdictSpec {
  kind: string;
  /** Width of the option space — the document's `totals` length. For a Majority Judgment
   * election it is five times the candidate count, because the MJ ballot grades every
   * candidate and `totals` is the raw per-(candidate, grade) distribution. */
  optionCount: number;
  seats: number;
  seatRule: string | null;
  quorum: Dec;
  approvalThresholdPc: Dec;
  minAffirmativeSupport: Dec;
  minUniqueVoters: number;
  /** Candidates excluded from seating because they withdrew — the document's
   * `withdrawn_excluded` (null = the exclusion was not in force, [] = it was and nobody
   * stood down). Not recomputable from Gateway state; it is an input like the ballots. */
  excluded: number[];
  /**
   * Accounts barred by the DAO-controlled-funds rule — the document's `excluded_accounts`. A
   * ballot from one of these is NOT A VOTE: it reaches no total, no weight sum, no abstention, no
   * grade, and is not a voter. It is the account that did not vote.
   *
   * Note what this is NOT: it is not a quorum adjustment. Quorum keeps its form exactly —
   * `total_weight >= quorum AND voter_count >= min_unique_voters` — measured over what is left.
   * The barred account never had a vote to withdraw, so there is no threshold to rescale, and
   * rescaling one would be inventing a rule the framework did not write ("this determines who may
   * vote; it does not change how quorum is measured").
   */
  excludedAccounts: string[];
  /**
   * The Grade Quantile the document publishes in `majority_judgment.grade_quantile` — the
   * fraction THIS result was settled at, which is the fraction it must be recomputed at.
   *
   * `null` means the document does not publish one, which is every document before v15. Those
   * fall back to {@link THREE_FIFTHS}, the quantile the engine of that vintage applied, and the
   * recomputed `majority_judgment` omits the field in turn so a v14 document still compares
   * equal to itself.
   *
   * An absent field is therefore not a loophole: it does not let a publisher apply a quantile of
   * their choosing unannounced, it pins them to three-fifths. A tally settled at anything else
   * and published without saying so recomputes to different grades and reports as a figure
   * difference.
   */
  gradeQuantile: GradeQuantile | null;
}

export interface MjCandidate {
  candidateIndex: number;
  byGrade: Dec[];
  cast: Dec;
  qualifying: number | null;
  above: Dec;
  below: Dec;
}

export interface MjResult {
  candidates: MjCandidate[];
  winners: number[];
  referredTieUnresolved: number[];
  invalidBallots: number[];
}

/** The full set of figures the document publishes, recomputed from the same inputs. */
export interface DerivedFigures {
  weights: Map<string, Dec>;
  totals: Dec[];
  totalWeight: Dec;
  abstainWeight: Dec;
  voterCount: number;
  /** Per entry of the document's `votes`, in order: was this ballot barred? Derived from the
   * register, so the document's own `excluded` flags can be checked against it rather than
   * believed. */
  voteExcluded: boolean[];
  quorumMet: boolean;
  masMet: boolean | null;
  approveWeight: Dec | null;
  rejectWeight: Dec | null;
  approved: boolean | null;
  winners: number[] | null;
  /** The recomputed `majority_judgment` object in the exact shape the document carries, or
   * null when this is not a settled MJ election. Compared structurally, not field by field. */
  majorityJudgment: Json;
}

/**
 * The Binding verdict: quorum (resolved by the caller), the STRICT decisive ratio, and the
 * Minimum Affirmative Support floor. Strictly greater on the ratio, so an exact tie fails;
 * inclusive on the MAS floor, because a floor reached is a floor met. MAS is what keeps the
 * quorum leg honest: quorum counts abstaining weight, so without an affirmative floor a
 * proposal could be carried over quorum by weight that endorsed nothing.
 */
export function bindingApproved(
  approve: Dec,
  reject: Dec,
  thresholdPc: Dec,
  mas: Dec,
  quorumMet: boolean,
): boolean {
  const decisive = approve.add(reject);
  return (
    quorumMet &&
    approve.mul(Dec.fromInt(100)).gt(decisive.mul(thresholdPc)) &&
    approve.gte(mas)
  );
}

/**
 * Plurality: seat the highest approval totals, top N.
 *
 * This is the PLATFORM's current default and NOT a mechanism the DAO framework contains — the
 * word does not appear anywhere in it, and its default is Majority Judgment (Proposal & Voting
 * Framework §4.5). An earlier revision of the reference engine's published weight rule claimed
 * the Radix Network DAO Charter specifies plurality; that claim was false and was withdrawn
 * explicitly in the same version bump as this document revision, so it is withdrawn here too
 * rather than quietly reworded.
 *
 * Ties break toward the lowest candidate index — arbitrary, but
 * fixed and stated, which is the only thing a tie rule has to be — and a candidate with no
 * approval weight is never seated: an empty seat states something true, a seat filled at
 * zero support does not.
 *
 * `excluded` are removed BEFORE the truncation, not after: a withdrawn front-runner filtered
 * out downstream leaves the seat it occupied empty, where removing it here lets the next
 * candidate still standing take it.
 */
export function allocateSeatsPlurality(totals: Dec[], seats: number, excluded: number[]): number[] {
  const ranked: number[] = [];
  for (let i = 0; i < totals.length; i++) {
    const t = totals[i];
    if (t !== undefined && t.isPositive() && !excluded.includes(i)) ranked.push(i);
  }
  ranked.sort((a, b) => {
    const byWeight = (totals[b] as Dec).cmp(totals[a] as Dec);
    return byWeight !== 0 ? byWeight : a - b;
  });
  return ranked.slice(0, seats);
}

/**
 * Sequential proportional approval voting. Each round elects the unelected candidate with
 * the highest score, where a ballot contributes `weight / (1 + already-elected candidates it
 * approved)`. A voter who already put someone in a seat still has a say in the remaining
 * seats, but a diminished one — which is what stops a bloc voting one slate from taking
 * every seat.
 *
 * Deterministic (strictly-greater keeps the lowest index on a tie) and exact (Decimal
 * division by the round count), because the result is meant to be checkable by anyone who
 * disagrees with it.
 */
export function allocateSeatsSpav(
  ballots: Ballot[],
  candidateCount: number,
  seats: number,
  excluded: number[],
): number[] {
  const elected: number[] = [];
  while (elected.length < seats && elected.length < candidateCount) {
    let best: { candidate: number; score: Dec } | null = null;
    for (let candidate = 0; candidate < candidateCount; candidate++) {
      if (elected.includes(candidate) || excluded.includes(candidate)) continue;
      let score = Dec.ZERO;
      for (const ballot of ballots) {
        if (!ballot.selection.includes(candidate)) continue;
        const already = ballot.selection.filter((a) => elected.includes(a)).length;
        score = score.add(ballot.weight.div(Dec.fromInt(already + 1)));
      }
      if (best === null || score.gt(best.score)) best = { candidate, score };
    }
    // Nobody left with any support — stop rather than seat someone at zero.
    if (best === null || !best.score.isPositive()) break;
    elected.push(best.candidate);
  }
  return elected;
}

/**
 * Decode one MJ ballot's raw selection into a grade per candidate. The encoding is
 * `candidate_index * 5 + grade_ordinal`, so a complete ballot is exactly `candidate_count`
 * indices. A ballot that leaves any candidate ungraded — or grades one twice, or goes out of
 * range — is INVALID, not partial: "Voters assign exactly one grade to every candidate."
 * The empty ballot (an abstention elsewhere) is invalid here for the same reason: MJ has no
 * abstention.
 */
function decodeMjBallot(selection: number[], candidateCount: number): number[] | null {
  if (selection.length !== candidateCount) return null;
  const grades: number[] = new Array<number>(candidateCount).fill(-1);
  for (const raw of selection) {
    if (!Number.isInteger(raw) || raw < 0) return null;
    const candidate = Math.floor(raw / GRADES.length);
    const grade = raw % GRADES.length;
    if (candidate >= candidateCount || grades[candidate] !== -1) return null;
    grades[candidate] = grade;
  }
  if (grades.some((g) => g === -1)) return null;
  return grades;
}

/**
 * Qualifying grade: the highest grade at which the weight grading the candidate at or above
 * that grade reaches the Grade Quantile of the weight cast for them.
 *
 * The quantile is the caller's — the fraction the document published — not a constant here. It
 * has already moved once (the median through to three-fifths on 2026-08-05,
 * Shadaffy/radix-dao-governance b98269e), which is exactly why a stored result carries the one
 * it was settled at.
 *
 * Compared as `atOrAbove * denominator >= cast * numerator` rather than against
 * `cast.mul(numerator).div(denominator)`, so a candidate sitting exactly on the quantile
 * resolves upward exactly, rather than by whichever way truncating fixed-point division happened
 * to fall.
 */
function qualifyingGrade(byGrade: Dec[], cast: Dec, quantile: GradeQuantile): number | null {
  if (!cast.isPositive()) return null;
  const numerator = Dec.fromInt(quantile.numerator);
  const denominator = Dec.fromInt(quantile.denominator);
  let atOrAbove = Dec.ZERO;
  for (let ordinal = 0; ordinal < byGrade.length; ordinal++) {
    atOrAbove = atOrAbove.add(byGrade[ordinal] as Dec);
    if (atOrAbove.mul(denominator).gte(cast.mul(numerator))) return ordinal;
  }
  // Unreachable while cast is the sum of byGrade, but a fallback beats a crash in a tally a
  // challenger is entitled to run on inputs nobody chose.
  return GRADES.length - 1;
}

/**
 * Majority Judgment: tally every ballot into per-candidate grade distributions, qualifying
 * grades and gauges, then rank the seatable candidates and fill `seats`.
 *
 * Seating order: withdrawn and never-graded candidates are not seatable; neither is a
 * candidate whose qualifying grade is below Good — the Minimum Qualifying Grade is a FLOOR,
 * not a tie-break input. The rest rank by qualifying grade, then by the majority gauge: p > q
 * outranks p == q outranks p < q; higher p wins inside p > q; LOWER q wins inside p < q. A
 * residual tie — same qualifying grade, same p, same q — is NOT broken by candidate index: if
 * such a group straddles the seat boundary, seating STOPS there and the group is referred.
 * Index decides where a candidate sits, never whether.
 *
 * `quantile` is the Grade Quantile to settle at — the document's own published fraction. It
 * defaults to three-fifths only for a caller that has no document to ask (the unit tests, and
 * any document predating the field).
 */
export function allocateSeatsMajorityJudgment(
  ballots: Ballot[],
  candidateCount: number,
  seats: number,
  excluded: number[],
  quantile: GradeQuantile = THREE_FIFTHS,
): MjResult {
  const byGrade: Dec[][] = [];
  for (let c = 0; c < candidateCount; c++) byGrade.push(new Array<Dec>(GRADES.length).fill(Dec.ZERO));
  const invalidBallots: number[] = [];

  ballots.forEach((ballot, position) => {
    const grades = decodeMjBallot(ballot.selection, candidateCount);
    if (grades === null) {
      invalidBallots.push(ballot.ballotIndex ?? position);
      return;
    }
    grades.forEach((grade, candidate) => {
      const row = byGrade[candidate] as Dec[];
      row[grade] = (row[grade] as Dec).add(ballot.weight);
    });
  });

  const candidates: MjCandidate[] = byGrade.map((grades, candidateIndex) => {
    const cast = grades.reduce((acc, w) => acc.add(w), Dec.ZERO);
    const qualifying = qualifyingGrade(grades, cast, quantile);
    let above = Dec.ZERO;
    let below = Dec.ZERO;
    if (qualifying !== null) {
      above = grades.slice(0, qualifying).reduce((acc, w) => acc.add(w), Dec.ZERO);
      below = grades.slice(qualifying + 1).reduce((acc, w) => acc.add(w), Dec.ZERO);
    }
    return { candidateIndex, byGrade: grades, cast, qualifying, above, below };
  });

  // The gauge's sign as an ordering key: 0 = p > q (best), 1 = p == q, 2 = p < q.
  const gaugeClass = (c: MjCandidate): number => c.above.gt(c.below) ? 0 : c.above.eq(c.below) ? 1 : 2;

  const ranked = candidates.filter(
    (c) => !excluded.includes(c.candidateIndex) && c.qualifying !== null && c.qualifying <= MINIMUM_QUALIFYING_GRADE,
  );
  ranked.sort((a, b) => {
    const byQualifying = (a.qualifying as number) - (b.qualifying as number);
    if (byQualifying !== 0) return byQualifying;
    const byClass = gaugeClass(a) - gaugeClass(b);
    if (byClass !== 0) return byClass;
    // Within p > q a higher p wins; within p < q a lower q wins. The p == q class has no
    // secondary key — its members are the residual tie handled below.
    const cls = gaugeClass(a);
    if (cls === 0) return b.above.cmp(a.above);
    if (cls === 2) return a.below.cmp(b.below);
    return 0;
  });

  const indistinguishable = (a: MjCandidate, b: MjCandidate): boolean =>
    a.qualifying === b.qualifying && a.above.eq(b.above) && a.below.eq(b.below);

  const winners: number[] = [];
  const referred: number[] = [];
  let cursor = 0;
  while (cursor < ranked.length && winners.length < seats) {
    let end = cursor + 1;
    while (end < ranked.length && indistinguishable(ranked[cursor] as MjCandidate, ranked[end] as MjCandidate)) {
      end++;
    }
    const group = ranked.slice(cursor, end);
    if (winners.length + group.length <= seats) {
      for (const c of group) winners.push(c.candidateIndex);
      cursor = end;
    } else {
      // The group straddles the boundary: some of its members would be seated and some not,
      // on no stated basis. Seat none of them and stop; the seats stay unfilled.
      for (const c of group) referred.push(c.candidateIndex);
      break;
    }
  }

  return { candidates, winners, referredTieUnresolved: referred, invalidBallots };
}

/**
 * The recomputed `majority_judgment` object, in the exact shape the document carries
 * (`qualifying_grade` per candidate, `minimum_qualifying_grade` at the block, and from v15 the
 * `grade_quantile` fraction the result was settled at).
 *
 * `published` is echoed back exactly as the document stated it, and OMITTED when the document
 * stated none. The block is compared structurally, so emitting a field a v14 document does not
 * carry would report every pre-v15 election as a figure difference — the field is absent there
 * because the engine of that vintage did not write it, not because anything disagrees.
 */
function majorityJudgmentJson(r: MjResult, published: GradeQuantile | null): Json {
  return {
    grades: [...GRADES],
    minimum_qualifying_grade: GRADES[MINIMUM_QUALIFYING_GRADE] as string,
    ...(published === null
      ? {}
      : {
          grade_quantile: {
            numerator: published.numerator,
            denominator: published.denominator,
          },
        }),
    candidates: r.candidates.map((c) => ({
      candidate_index: c.candidateIndex,
      by_grade: c.byGrade.map((w) => w.toString()),
      cast: c.cast.toString(),
      qualifying_grade: c.qualifying,
      above: c.above.toString(),
      below: c.below.toString(),
    })),
    referred_tie_unresolved: r.referredTieUnresolved,
    invalid_ballots: r.invalidBallots,
  };
}

/**
 * Re-derive every figure the document publishes from the ballots and the recomputed weights.
 *
 * The candidate count is taken from the width of the document's own `totals` (five per
 * candidate under MJ): the document does not carry a separate candidate_count field, so its
 * option space is the statement of how many candidates there were. Approval voting: each
 * selected option receives the voter's full weight. An empty selection is an abstention —
 * its weight counts toward total_weight (and therefore quorum) and toward no option.
 *
 * Unless the account is barred. A ballot from an account in `spec.excludedAccounts` is skipped
 * whole, before any of that: no total, no total_weight, no abstention (a barred empty selection
 * abstains from nothing — it is not a participant), no voter, no grade, no `cast`. The single
 * `continue` below is the entire rule, and it is written once precisely so no aggregate can be
 * added later that quietly forgets it.
 *
 * Or unless, under Majority Judgment, the ballot is INVALID — one that does not grade every
 * candidate exactly once. Participation is the total power of VALID ballots only (On-Chain
 * Identifiers & Verification Policy §4; Proposal & Voting Framework §6.3), so an invalid ballot
 * reaches no option total, no `total_weight` and no `voter_count` either, and therefore cannot
 * carry an election over quorum without expressing a single grade. It does still reach the
 * allocator, because the allocator is what REPORTS it in `invalid_ballots` — that is the whole
 * difference between the two exclusions, and why they are two `continue`s and not one.
 *
 * The two compose in one direction only. A barred ballot is struck first and never reaches the
 * validity check, so it can never be reported invalid: it was not eligible to be judged, and
 * naming it in `invalid_ballots` would accuse a voter of malformity on a ballot that was never
 * read.
 */
export function deriveFigures(
  spec: VerdictSpec,
  votes: Array<{ account: string; selection: number[] }>,
  weights: Map<string, Dec>,
): DerivedFigures {
  const useMj = spec.kind === "Election" && spec.seatRule === "MajorityJudgment";
  const optionCount = spec.optionCount;
  const candidateCount = useMj ? optionCount / GRADES.length : optionCount;

  const totals: Dec[] = new Array<Dec>(optionCount).fill(Dec.ZERO);
  let totalWeight = Dec.ZERO;
  let abstainWeight = Dec.ZERO;
  const ballots: Ballot[] = [];

  const barred = new Set(spec.excludedAccounts);
  const voteExcluded: boolean[] = [];
  let voterCount = 0;

  for (let i = 0; i < votes.length; i++) {
    const vote = votes[i] as (typeof votes)[number];
    if (barred.has(vote.account)) {
      voteExcluded.push(true);
      continue;
    }
    voteExcluded.push(false);
    const weight = weights.get(vote.account) ?? Dec.ZERO;
    // In the ballot list even when invalid: the allocator has to SEE an invalid ballot to report
    // it. `ballotIndex` keeps the report naming positions in the document's `votes`, which the
    // barred ballots above have already made non-consecutive.
    const selection = vote.selection.filter((x) => x >= 0 && x < optionCount);
    ballots.push({ weight, selection, ballotIndex: i });

    // Validity is decided by `decodeMjBallot`, the same oracle the allocator uses, over the same
    // out-of-range filter it applies. A second copy of the rule here would be free to drift, and
    // would then disagree with the `invalid_ballots` list in the very same document.
    if (useMj && decodeMjBallot(selection, candidateCount) === null) continue;

    voterCount++;
    totalWeight = totalWeight.add(weight);
    if (vote.selection.length === 0) abstainWeight = abstainWeight.add(weight);
    for (const idx of vote.selection) {
      const t = totals[idx];
      if (t !== undefined) totals[idx] = t.add(weight);
    }
  }

  // Quorum has two legs: enough weight, and (when a floor is set) enough distinct voters. One
  // ballot per account in the document, so the count of ballots that ARE votes is the
  // distinct-voter count. The form is untouched by the bar: barred weight and barred voters were
  // never in the measurement, and neither threshold moves to compensate.
  const quorumMet = totalWeight.gte(spec.quorum) && voterCount >= spec.minUniqueVoters;

  // Approve/Reject only mean something for a Binding consultation, whose option list is fixed
  // at [Reject, Approve]. Elsewhere there is no single affirmative side, so the verdict is
  // null rather than invented.
  const binding = spec.kind === "Binding" && totals.length === 2;
  const approveWeight = binding ? (totals[1] as Dec) : null;
  const rejectWeight = binding ? (totals[0] as Dec) : null;
  const masMet = binding ? (totals[1] as Dec).gte(spec.minAffirmativeSupport) : null;
  const approved = binding
    ? bindingApproved(
        totals[1] as Dec,
        totals[0] as Dec,
        spec.approvalThresholdPc,
        spec.minAffirmativeSupport,
        quorumMet,
      )
    : null;

  // Missing quorum means no winners, not "the winners, but ignore them" — a reader who sees
  // a filled seat list will act on it. Plurality is the fallback when an election names no rule,
  // because it is what the reference engine falls back to and this verifier's job is to
  // reproduce that engine's answer — not because the framework endorses it. It does not: the
  // framework's default is Majority Judgment.
  const election = spec.kind === "Election" && spec.seats > 0;
  let winners: number[] | null = null;
  let majorityJudgment: Json = null;
  if (election && quorumMet) {
    if (useMj) {
      const mj = allocateSeatsMajorityJudgment(
        ballots,
        candidateCount,
        spec.seats,
        spec.excluded,
        // The document's own fraction, or three-fifths when it publishes none. Never a constant
        // chosen here over one the document states.
        spec.gradeQuantile ?? THREE_FIFTHS,
      );
      winners = mj.winners;
      majorityJudgment = majorityJudgmentJson(mj, spec.gradeQuantile);
    } else if (spec.seatRule === "Spav") {
      winners = allocateSeatsSpav(ballots, candidateCount, spec.seats, spec.excluded);
    } else {
      winners = allocateSeatsPlurality(totals, spec.seats, spec.excluded);
    }
  }

  return {
    weights,
    totals,
    totalWeight,
    abstainWeight,
    voterCount,
    voteExcluded,
    quorumMet,
    masMet,
    approveWeight,
    rejectWeight,
    approved,
    winners,
    majorityJudgment,
  };
}
