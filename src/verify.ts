/**
 * Orchestration: recompute the weights, re-derive the verdict, re-serialize, re-hash, and
 * classify the answer exactly as the README promises:
 *
 *   figures match, hash differs  -> SERIALIZATION disagreement, not a lie.
 *   figures differ               -> the real signal.
 *   gateway trouble              -> UNKNOWN, never "failed".
 *
 * The order is load-bearing. Figures are compared first because they are the check that does
 * not depend on the serialization spec at all; the hash is only consulted once the figures
 * agree, so a serialization drift can never masquerade as an arithmetic lie.
 */

import { canonicalize, tallyHash } from "./canonical.ts";
import type { Json } from "./canonical.ts";
import { Dec } from "./decimal.ts";
import { DocumentError, parseTallyDocument } from "./document.ts";
import type { TallyDocument } from "./document.ts";
import { GatewayError } from "./gateway.ts";
import type { GatewayClient } from "./gateway.ts";
import { deriveFigures } from "./verdict.ts";
import type { DerivedFigures } from "./verdict.ts";
import { computeAccountWeights } from "./weights.ts";

export interface Difference {
  field: string;
  document: string;
  recomputed: string;
}

export type Outcome =
  | { kind: "match"; hashChecked: boolean }
  | { kind: "figures"; differences: Difference[] }
  | { kind: "serialization"; expectedHash: string | null; detail: string }
  | { kind: "unknown"; reason: string }
  | { kind: "malformed"; reason: string };

function dec(v: Dec | null): string {
  return v === null ? "null" : v.toString();
}

function bool(v: boolean | null): string {
  return v === null ? "null" : String(v);
}

function intArray(v: number[] | null): string {
  return v === null ? "null" : `[${v.join(",")}]`;
}

/** Structural comparison via the canonical form: key order and whitespace are the
 * serializer's business, not the comparison's. */
function sameJson(a: Json, b: Json): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    // An uncanonicalizable value (a float) is a difference by definition.
    return false;
  }
}

/** Every figure the verdict depends on, document claim against recomputation. */
export function compareFigures(doc: TallyDocument, derived: DerivedFigures): Difference[] {
  const diffs: Difference[] = [];
  const check = (field: string, document: string, recomputed: string): void => {
    if (document !== recomputed) diffs.push({ field, document, recomputed });
  };

  for (let i = 0; i < doc.votes.length; i++) {
    const vote = doc.votes[i] as (typeof doc.votes)[number];
    // A barred ballot's weight is still checked. It has to be: the published weight is what the
    // exclusion kept out of the tally, and a verifier that stopped recomputing it could not tell
    // a correctly barred account from one whose weight was quietly wrong.
    const recomputed = derived.weights.get(vote.account) ?? Dec.ZERO;
    check(`votes[${i}].weight (${vote.account})`, vote.weight.toString(), recomputed.toString());
    // And the flag is a claim like any other: the register decides, the flag is checked against
    // it. A ballot flagged excluded whose account is not in the register — or an account in the
    // register whose ballot was silently counted — is a figure difference, not a formatting one.
    check(
      `votes[${i}].excluded (${vote.account})`,
      String(vote.excluded),
      String(derived.voteExcluded[i] ?? false),
    );
  }

  const totalsLen = Math.max(doc.totals.length, derived.totals.length);
  for (let i = 0; i < totalsLen; i++) {
    check(`totals[${i}]`, dec(doc.totals[i] ?? null), dec(derived.totals[i] ?? null));
  }
  check("total_weight", doc.totalWeight.toString(), derived.totalWeight.toString());
  check("abstain_weight", doc.abstainWeight.toString(), derived.abstainWeight.toString());
  check("voter_count", String(doc.voterCount), String(derived.voterCount));
  check("quorum_met", String(doc.quorumMet), String(derived.quorumMet));
  check("mas_met", bool(doc.masMet), bool(derived.masMet));
  check("approve_weight", dec(doc.approveWeight), dec(derived.approveWeight));
  check("reject_weight", dec(doc.rejectWeight), dec(derived.rejectWeight));
  check("approved", bool(doc.approved), bool(derived.approved));
  check("winners", intArray(doc.winners), intArray(derived.winners));
  if (!sameJson(doc.majorityJudgment, derived.majorityJudgment)) {
    diffs.push({
      field: "majority_judgment",
      document: canonicalize(doc.majorityJudgment),
      recomputed: canonicalize(derived.majorityJudgment),
    });
  }
  return diffs;
}

/**
 * Verify one tally document against Gateway state.
 *
 * `expectedHash` is the on-chain `tally_hash` when the caller has it (or the envelope's
 * `document_hash_blake2b` when given the API response). Without it only the figures are
 * checked and the outcome says so — a figure match with an unchecked hash is not the same
 * claim as a full match.
 */
export async function verifyTallyDocument(
  input: unknown,
  expectedHash: string | null,
  gw: GatewayClient,
  xrdResource: string,
): Promise<Outcome> {
  let doc: TallyDocument;
  let envelopeHash: string | null;
  try {
    ({ doc, envelopeHash } = parseTallyDocument(input));
  } catch (e) {
    if (e instanceof DocumentError) return { kind: "malformed", reason: e.message };
    throw e;
  }
  const hash = expectedHash ?? envelopeHash;

  let derived: DerivedFigures;
  try {
    const accounts = doc.votes.map((v) => v.account);
    const weights = await computeAccountWeights(
      gw,
      accounts,
      doc.snapshotStateVersion,
      doc.weightSources,
      xrdResource,
    );
    derived = deriveFigures(
      {
        kind: doc.kind,
        optionCount: doc.totals.length,
        seats: doc.seats,
        seatRule: doc.seatRule,
        quorum: doc.quorum,
        approvalThresholdPc: doc.approvalThresholdPc,
        minAffirmativeSupport: doc.minAffirmativeSupport,
        minUniqueVoters: doc.minUniqueVoters,
        excluded: doc.withdrawnExcluded ?? [],
        excludedAccounts: doc.excludedAccounts,
      },
      doc.votes,
      weights,
    );
  } catch (e) {
    if (e instanceof GatewayError) return { kind: "unknown", reason: e.message };
    if (e instanceof DocumentError) return { kind: "malformed", reason: e.message };
    throw e;
  }

  const differences = compareFigures(doc, derived);
  if (differences.length > 0) return { kind: "figures", differences };

  // Figures agree. Only now does the byte-level question matter: is the document's canonical
  // form the one the hash commits to? A document that cannot be canonicalized at all (a float
  // where a Decimal string belongs) departed from the spec — that is the serialization class,
  // not a malformed document, because it parsed fine as JSON.
  let recomputedHash: string;
  try {
    recomputedHash = tallyHash(doc.raw);
  } catch (e) {
    return {
      kind: "serialization",
      expectedHash: hash,
      detail: `the document cannot be canonicalized per the spec: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (hash !== null && recomputedHash !== hash) {
    return {
      kind: "serialization",
      expectedHash: hash,
      detail: `figures agree but the hash does not: document recomputes to ${recomputedHash}`,
    };
  }
  return { kind: "match", hashChecked: hash !== null };
}
