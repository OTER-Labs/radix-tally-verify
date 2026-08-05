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
 * SPAV divides by an integer round count and Majority Judgment's "exact halves resolve
 * upward" is only exact because the comparison never divides.
 */

import { Dec } from "./decimal.ts";
import type { Json } from "./canonical.ts";

/** The five grades of the framework's scale, highest first. Ordinal 0 is Excellent, 4 is
 * Poor — the ordering is load-bearing, since "at or above grade g" is the whole median rule. */
export const GRADES = ["Excellent", "Very Good", "Good", "Acceptable", "Poor"] as const;

/** Lowest median grade at which a candidate may be seated ("Good"). An ordinal, so the
 * comparison is `median <= MINIMUM_MEDIAN_GRADE` — lower ordinal is better. */
export const MINIMUM_MEDIAN_GRADE = 2;

export interface Ballot {
  weight: Dec;
  selection: number[];
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
}

export interface MjCandidate {
  candidateIndex: number;
  byGrade: Dec[];
  cast: Dec;
  median: number | null;
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
 * Plurality: seat the highest approval totals, top N. What the Radix Network DAO Charter
 * specifies for RAC elections. Ties break toward the lowest candidate index — arbitrary, but
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
 * Median grade: the highest grade at which the weight grading the candidate at or above that
 * grade reaches half the weight cast for them. Compared as `atOrAbove * 2 >= cast` rather
 * than against `cast / 2`, so "exact halves resolve upward" is exact rather than an artifact
 * of truncating fixed-point division.
 */
function medianGrade(byGrade: Dec[], cast: Dec): number | null {
  if (!cast.isPositive()) return null;
  let atOrAbove = Dec.ZERO;
  for (let ordinal = 0; ordinal < byGrade.length; ordinal++) {
    atOrAbove = atOrAbove.add(byGrade[ordinal] as Dec);
    if (atOrAbove.mul(Dec.fromInt(2)).gte(cast)) return ordinal;
  }
  // Unreachable while cast is the sum of byGrade, but a fallback beats a crash in a tally a
  // challenger is entitled to run on inputs nobody chose.
  return GRADES.length - 1;
}

/**
 * Majority Judgment: tally every ballot into per-candidate grade distributions, medians and
 * gauges, then rank the seatable candidates and fill `seats`.
 *
 * Seating order: withdrawn and never-graded candidates are not seatable; neither is a
 * candidate whose median is below Good — the minimum median is a FLOOR, not a tie-break
 * input. The rest rank by median, then by the majority gauge: p > q outranks p == q outranks
 * p < q; higher p wins inside p > q; LOWER q wins inside p < q. A residual tie — same
 * median, same p, same q — is NOT broken by candidate index: if such a group straddles the
 * seat boundary, seating STOPS there and the group is referred. Index decides where a
 * candidate sits, never whether.
 */
export function allocateSeatsMajorityJudgment(
  ballots: Ballot[],
  candidateCount: number,
  seats: number,
  excluded: number[],
): MjResult {
  const byGrade: Dec[][] = [];
  for (let c = 0; c < candidateCount; c++) byGrade.push(new Array<Dec>(GRADES.length).fill(Dec.ZERO));
  const invalidBallots: number[] = [];

  ballots.forEach((ballot, ballotIndex) => {
    const grades = decodeMjBallot(ballot.selection, candidateCount);
    if (grades === null) {
      invalidBallots.push(ballotIndex);
      return;
    }
    grades.forEach((grade, candidate) => {
      const row = byGrade[candidate] as Dec[];
      row[grade] = (row[grade] as Dec).add(ballot.weight);
    });
  });

  const candidates: MjCandidate[] = byGrade.map((grades, candidateIndex) => {
    const cast = grades.reduce((acc, w) => acc.add(w), Dec.ZERO);
    const median = medianGrade(grades, cast);
    let above = Dec.ZERO;
    let below = Dec.ZERO;
    if (median !== null) {
      above = grades.slice(0, median).reduce((acc, w) => acc.add(w), Dec.ZERO);
      below = grades.slice(median + 1).reduce((acc, w) => acc.add(w), Dec.ZERO);
    }
    return { candidateIndex, byGrade: grades, cast, median, above, below };
  });

  // The gauge's sign as an ordering key: 0 = p > q (best), 1 = p == q, 2 = p < q.
  const gaugeClass = (c: MjCandidate): number => c.above.gt(c.below) ? 0 : c.above.eq(c.below) ? 1 : 2;

  const ranked = candidates.filter(
    (c) => !excluded.includes(c.candidateIndex) && c.median !== null && c.median <= MINIMUM_MEDIAN_GRADE,
  );
  ranked.sort((a, b) => {
    const byMedian = (a.median as number) - (b.median as number);
    if (byMedian !== 0) return byMedian;
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
    a.median === b.median && a.above.eq(b.above) && a.below.eq(b.below);

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

/** The recomputed `majority_judgment` object, in the exact shape the document carries. */
function majorityJudgmentJson(r: MjResult): Json {
  return {
    grades: [...GRADES],
    minimum_median_grade: GRADES[MINIMUM_MEDIAN_GRADE] as string,
    candidates: r.candidates.map((c) => ({
      candidate_index: c.candidateIndex,
      by_grade: c.byGrade.map((w) => w.toString()),
      cast: c.cast.toString(),
      median: c.median,
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

  for (const vote of votes) {
    const weight = weights.get(vote.account) ?? Dec.ZERO;
    totalWeight = totalWeight.add(weight);
    if (vote.selection.length === 0) abstainWeight = abstainWeight.add(weight);
    for (const idx of vote.selection) {
      const t = totals[idx];
      if (t !== undefined) totals[idx] = t.add(weight);
    }
    ballots.push({ weight, selection: vote.selection.filter((i) => i >= 0 && i < optionCount) });
  }

  // Quorum has two legs: enough weight, and (when a floor is set) enough distinct voters.
  // One ballot per account in the document, so votes.length IS the distinct-voter count.
  const quorumMet = totalWeight.gte(spec.quorum) && votes.length >= spec.minUniqueVoters;

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
  // a filled seat list will act on it. Plurality is the fallback when an election names no
  // rule: it is what the charter specifies, so an absent rule falls to the conformant one.
  const election = spec.kind === "Election" && spec.seats > 0;
  let winners: number[] | null = null;
  let majorityJudgment: Json = null;
  if (election && quorumMet) {
    if (useMj) {
      const mj = allocateSeatsMajorityJudgment(ballots, candidateCount, spec.seats, spec.excluded);
      winners = mj.winners;
      majorityJudgment = majorityJudgmentJson(mj);
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
    voterCount: votes.length,
    quorumMet,
    masMet,
    approveWeight,
    rejectWeight,
    approved,
    winners,
    majorityJudgment,
  };
}
