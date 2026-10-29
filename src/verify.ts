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
import { WeightRuleError } from "./concentrated.ts";
import { Dec } from "./decimal.ts";
import { DocumentError, parseTallyDocument } from "./document.ts";
import type { PinnedExcludedSet, PinnedWeightSet, TallyDocument } from "./document.ts";
import type { Sides } from "./framework.ts";
import { GatewayError } from "./gateway.ts";
import type { GatewayClient } from "./gateway.ts";
import { checkRegisterScope, verifyMirrorBallots } from "./mirror.ts";
import {
  QUICKNET_CHAIN,
  openBallot,
  sealingRound,
  validatePlaintext,
  verifyRoundSignature,
} from "./sealed.ts";
import type { SealedInvalid, SelectionRules } from "./sealed.ts";
import { deriveFigures } from "./verdict.ts";
import type { DerivedFigures } from "./verdict.ts";
import { assetSymbolFor, computeAccountWeights, serializeWeightSources } from "./weights.ts";
import { spaceRegisterProblem, weightRuleText, weightSourcesForSpace } from "./weight-rule.ts";

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
    // v18: the own/delegated split. `weight` above stays the account's OWN weight — publishing
    // the combined figure under that name would let a delegator's balance be re-read as the
    // delegate's on any later run — so the carried total is a separate pair of fields.
    check(
      `votes[${i}].delegated_weight (${vote.account})`,
      dec(vote.delegatedWeight),
      dec(derived.voteDelegatedWeight[i] ?? null),
    );
    check(
      `votes[${i}].effective_weight (${vote.account})`,
      dec(vote.effectiveWeight),
      dec(derived.voteEffectiveWeight[i] ?? null),
    );
  }

  // v18: the delegation resolution. Compared entry by entry rather than as one blob, so a
  // disagreement names the delegation it is about — including WHICH condition the two
  // implementations disagreed that a delegation failed, which is the thing a reader acts on.
  const docDelegations = doc.delegations;
  const derivedDelegations = derived.delegations;
  if ((docDelegations === null) !== (derivedDelegations === null)) {
    check(
      "delegations",
      docDelegations === null ? "null" : `[${docDelegations.length} entries]`,
      derivedDelegations === null ? "null" : `[${derivedDelegations.length} entries]`,
    );
  } else if (docDelegations !== null && derivedDelegations !== null) {
    const n = Math.max(docDelegations.length, derivedDelegations.length);
    for (let i = 0; i < n; i++) {
      const d = docDelegations[i];
      const r = derivedDelegations[i];
      const rWeight = derived.delegationWeights[i] ?? null;
      check(
        `delegations[${i}].delegator`,
        d === undefined ? "absent" : d.delegator,
        r === undefined ? "absent" : r.delegator,
      );
      check(
        `delegations[${i}].delegate`,
        d === undefined ? "absent" : d.delegate,
        r === undefined ? "absent" : r.delegate,
      );
      check(
        `delegations[${i}].weight`,
        d === undefined ? "absent" : d.weight.toString(),
        r === undefined ? "absent" : dec(rWeight),
      );
      check(
        `delegations[${i}].counted`,
        d === undefined ? "absent" : String(d.counted),
        r === undefined ? "absent" : String(r.refusal === null),
      );
      check(
        `delegations[${i}].reason`,
        d === undefined ? "absent" : (d.reason ?? "null"),
        r === undefined ? "absent" : (r.refusal ?? "null"),
      );
    }
  }
  check(
    "delegated_weight_total",
    dec(doc.delegatedWeightTotal),
    dec(derived.delegatedWeightTotal),
  );

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
 * Every sealed-vote claim (v23) that can be checked without the Gateway: the drand chain and the
 * published signature, the round formula of spec §1, each ballot's ciphertext opened and its
 * validity recomputed, and the late cut. Returns the differences; an empty list is a document
 * whose sealed claims hold.
 *
 * The checks are ordered so a document that is wrong at the top (another chain, a signature that
 * does not verify) stops there instead of burying the one real finding under a decrypt error per
 * ballot: nothing can be opened with a file key the signature did not produce.
 */
export async function compareSealedClaims(doc: TallyDocument): Promise<Difference[]> {
  const sealed = doc.sealed;
  if (sealed === null) return [];
  const diffs: Difference[] = [];
  const check = (field: string, document: string, recomputed: string): void => {
    if (document !== recomputed) diffs.push({ field, document, recomputed });
  };

  // An unrecognised box counts NO ballots (spec §6.4). The verifier cannot re-read the registry
  // to confirm recognition, but it can refuse a document whose own claim and ballot list
  // contradict each other: `box_recognised: false` beside a counted ballot cannot be honest.
  if (!sealed.boxRecognised) {
    check(
      "sealed.box_recognised (with ballots)",
      doc.votes.length === 0 ? "no counted ballots" : `${doc.votes.length} counted ballot(s)`,
      "no counted ballots",
    );
    check(
      "late_ballots (with an unrecognised box)",
      (doc.lateBallots?.length ?? 0) === 0 ? "none" : `${doc.lateBallots?.length ?? 0} late ballot(s)`,
      "none",
    );
    return diffs;
  }

  // The chain is quicknet and nothing else (spec §10): the chain hash is checked against the
  // published info, and the public key with it, because a signature verified against a key this
  // verifier does not know proves nothing about the ballots' timelock.
  const chainOk =
    sealed.chainHash.toLowerCase() === QUICKNET_CHAIN.chainHash &&
    sealed.publicKey.toLowerCase() === QUICKNET_CHAIN.publicKey;
  check("sealed.chain_hash", sealed.chainHash.toLowerCase(), QUICKNET_CHAIN.chainHash);
  check("sealed.public_key", sealed.publicKey.toLowerCase(), QUICKNET_CHAIN.publicKey);
  if (!chainOk) return diffs;

  const round = sealed.round as number;
  const roundTime = sealed.roundTime as number;
  const signature = sealed.signature as string;

  // T = vote_end + margin; round = floor((T - genesis) / period) + 1 (spec §1). Every layer
  // computes it, so a document that publishes another round or round_time is not this vote's.
  if (doc.voteEnd === null) {
    check("sealed.round_time", String(roundTime), "vote_end is absent from the document");
  } else {
    try {
      const expected = sealingRound(doc.voteEnd, sealed.roundMarginSeconds, QUICKNET_CHAIN);
      check("sealed.round", String(round), String(expected.round));
      check("sealed.round_time", String(roundTime), String(expected.roundTime));
    } catch (e) {
      check("sealed.round_time", String(roundTime), e instanceof Error ? e.message : String(e));
    }
  }

  // The signature is checked before anything is decrypted: a wrong signature makes every ballot
  // undecryptable, and reporting that as many findings would hide the one that matters.
  if (!(await verifyRoundSignature(QUICKNET_CHAIN, round, signature))) {
    diffs.push({
      field: "sealed.signature",
      document: signature,
      recomputed: `does not verify for round ${round} against sealed.public_key`,
    });
    return diffs;
  }

  // One timely ballot per account is the engine's latest-on-ledger rule; a document listing an
  // account twice would count its weight twice.
  const seen = new Set<string>();
  for (let i = 0; i < doc.votes.length; i++) {
    const account = (doc.votes[i] as (typeof doc.votes)[number]).account;
    if (seen.has(account)) {
      diffs.push({
        field: `votes[${i}].account (${account})`,
        document: "a duplicate ballot",
        recomputed: "one timely ballot per account",
      });
    }
    seen.add(account);
  }

  // The selection rules `cast_vote` applies. The document does not carry `max_selections` (it
  // does not on an open vote either), so the approval cap the creator chose cannot be checked
  // here; `optionCount` is the tightest bound the range and ordering rules already imply and
  // adds nothing of its own. `candidate_count` under Majority Judgment is derived from the
  // totals width, as the verdict already derives it.
  const majorityJudgment = doc.kind === "Election" && doc.seatRule === "MajorityJudgment";
  const optionCount = doc.options.length > 0 ? doc.options.length : doc.totals.length;
  const candidateCount = majorityJudgment ? doc.totals.length / 5 : 0;
  const rules: SelectionRules = {
    abstainAllowed: doc.abstainAllowed ?? true,
    maxSelections: optionCount,
    candidateCount,
    majorityJudgment,
    optionCount,
  };
  if (doc.abstainAllowed === null) {
    diffs.push({
      field: "abstain_allowed",
      document: "absent",
      recomputed: "the rule a sealed ballot's abstention is checked against",
    });
  }

  for (let i = 0; i < doc.votes.length; i++) {
    const vote = doc.votes[i] as (typeof doc.votes)[number];
    // The late cut: a ballot at or after round_time is late, and late ballots count nothing.
    // A `votes` row at or after round_time is the replacement the rule forbids.
    if (vote.timestamp !== null && vote.timestamp >= roundTime) {
      check(
        `votes[${i}].timestamp (${vote.account})`,
        String(vote.timestamp),
        `before round_time (${roundTime})`,
      );
    }
    const opened = await openBallot(vote.ciphertext as string, QUICKNET_CHAIN, round, signature);
    let reason: SealedInvalid | null = null;
    let decoded: number[] | null = null;
    if (!opened.ok) {
      reason = opened.reason;
    } else {
      const validated = validatePlaintext(
        opened.plaintext,
        doc.consultationId,
        vote.account,
        rules,
      );
      if (validated.ok) decoded = validated.selection;
      else reason = validated.reason;
    }
    const published = vote.sealedInvalid ?? "valid";
    check(`votes[${i}].sealed_invalid (${vote.account})`, published, reason ?? "valid");
    if (reason === null && decoded !== null) {
      check(
        `votes[${i}].selection (${vote.account})`,
        `[${vote.selection.join(",")}]`,
        `[${decoded.join(",")}]`,
      );
    }
  }

  const late = doc.lateBallots ?? [];
  for (let j = 0; j < late.length; j++) {
    const ballot = late[j] as (typeof late)[number];
    if (ballot.timestamp < roundTime) {
      check(
        `late_ballots[${j}].timestamp (${ballot.account})`,
        String(ballot.timestamp),
        `at or after round_time (${roundTime})`,
      );
    }
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
export interface VerifyOptions {
  /**
   * The weight-source set the document's `weight_set_version` names, and its registry's network.
   * Read only for a mirror document, by check (g); without it the document's own register stands
   * in for the set.
   */
  weightSet?: PinnedWeightSet;
  /**
   * The excluded set `excluded_set_version` names. With it, the version and the embedded
   * `excluded_accounts` list are checked against the registry's set; without it, both are
   * carried and hashed but not checked (the registry is a different source from the Gateway
   * endpoints this tool reads).
   */
  excludedSet?: PinnedExcludedSet;
}

export async function verifyTallyDocument(
  input: unknown,
  expectedHash: string | null,
  gw: GatewayClient,
  xrdResource: string,
  options: VerifyOptions = {},
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

  // Structural consistency that needs no Gateway: the rule text the document states, the
  // register its space implies, and — when the caller supplied the registry's sets — the
  // versions and the sets those versions name.
  const consistencyDifferences: Difference[] = [];
  const checkConsistent = (field: string, document: string, recomputed: string): void => {
    if (document !== recomputed) consistencyDifferences.push({ field, document, recomputed });
  };
  // The equality is a v22 rule: that is the version whose `weight_rule` the current text
  // describes. v23 appends the sealed sentences to it, which this verifier does not reproduce
  // word for word (the reference engine owns that text), so a v23 document is checked for the
  // v22 prefix only — enough to catch a rule swapped wholesale without inventing an equality
  // against text no side of this repo has pinned. Older documents state the rule of their own
  // vintage, which is legitimately not today's text and is still committed by the hash.
  if (doc.tallyDocVersion === 22 && doc.weightRule !== null) {
    checkConsistent("weight_rule", doc.weightRule, weightRuleText(doc.weightConfig));
  } else if (doc.tallyDocVersion === 23 && doc.weightRule !== null) {
    const prefix = weightRuleText(doc.weightConfig);
    if (!doc.weightRule.startsWith(prefix)) {
      consistencyDifferences.push({
        field: "weight_rule",
        document: doc.weightRule.slice(0, 200),
        recomputed: `${prefix.slice(0, 200)}… followed by the v23 sealed sentences`,
      });
    }
  }
  const registerProblem = spaceRegisterProblem(doc.weightConfig, doc.weightSources);
  if (registerProblem !== null) {
    consistencyDifferences.push({
      field: "weight_sources",
      document: registerProblem,
      recomputed: `the register ${doc.weightConfig.kind} implies`,
    });
  }
  if (options.weightSet !== undefined && !doc.isMirror) {
    checkConsistent("weight_set_version", String(doc.weightSetVersion), String(options.weightSet.version));
    const expected = weightSourcesForSpace(doc.weightConfig, options.weightSet.sources);
    checkConsistent(
      "weight_sources",
      canonicalize(serializeWeightSources(doc.weightSources) as unknown as Json),
      canonicalize(serializeWeightSources(expected) as unknown as Json),
    );
  }
  if (options.excludedSet !== undefined) {
    checkConsistent("excluded_set_version", String(doc.excludedSetVersion), String(options.excludedSet.version));
    checkConsistent(
      "excluded_accounts",
      canonicalize(doc.excludedAccounts),
      canonicalize(options.excludedSet.accounts),
    );
  }

  // v23: the sealed claims need no Gateway at all, so they are settled before any read. A
  // document already refused here is FIGURES whatever the Gateway would have said; running the
  // weight walk first would let an unreachable Gateway turn a definite finding into UNKNOWN.
  const sealedClaimDifferences = await compareSealedClaims(doc);
  if (sealedClaimDifferences.length > 0) {
    return {
      kind: "figures",
      differences: [...consistencyDifferences, ...sealedClaimDifferences],
    };
  }

  let mirrorDifferences: Difference[] = [];
  let assetSymbolDifferences: Difference[] = [];
  let derived: DerivedFigures;
  try {
    // Mirror documents (`ballot_source` present, `src/mirror.ts`) get extra checks on top of
    // the pipeline below, which runs unchanged for (c) (the OTER-rule figures every mirror
    // document already carries at top level, exactly as a Poll would). Run first, in the same
    // try/catch: a gateway or register problem here is exactly as UNKNOWN/MALFORMED as one in the
    // weight recomputation, and the two share the classification below rather than duplicate it.
    //
    // Check (g) comes first and touches no gateway: it decides the register the OTER leg is
    // weighed under — here and in (e) — so that a register address is never sent to a gateway on
    // another network, whatever the document claims.
    let oterSources = doc.weightSources;
    let mirrorSides: Sides | null = null;
    if (doc.isMirror) {
      const scoped = checkRegisterScope(doc, options.weightSet ?? null);
      oterSources = scoped.applied;
      const mirror = await verifyMirrorBallots(doc, gw, xrdResource, oterSources);
      mirrorSides = mirror.sides;
      mirrorDifferences = [...scoped.differences, ...mirror.differences];
    }

    // Every account whose weight any published figure depends on: the ballots, plus (v18) every
    // DELEGATOR in force at the snapshot. A delegator who never voted still has a weight in the
    // document's `delegations` report and, when the delegation counted, inside a delegate's
    // effective weight — so omitting them here would recompute those figures as zero and report
    // an honest document as a lie.
    const accounts = [
      ...new Set([
        ...doc.votes.map((v) => v.account),
        ...(doc.delegationInput ?? []).map((d) => d.delegator),
      ]),
    ];
    const weights = await computeAccountWeights(
      gw,
      accounts,
      doc.snapshotStateVersion,
      oterSources,
      xrdResource,
    );

    // v22: the ticker the weights are denominated in, checked against the resource's own
    // `symbol` metadata AT THE SNAPSHOT — "XRD" for the Xrd rule (no gateway call), the named
    // resource's declared symbol ("" if it names none) for a Fungible/Membership space. A
    // mismatch is a figures-class finding like any other published claim: `asset_symbol` sits
    // inside the hashed document, so a wrong one is exactly as checkable as a wrong weight.
    const configResource = doc.weightConfig.kind === "Xrd" ? null : doc.weightConfig.resource;
    const expectedAssetSymbol = await assetSymbolFor(gw, configResource, doc.snapshotStateVersion);
    if (expectedAssetSymbol !== doc.assetSymbol) {
      assetSymbolDifferences = [
        { field: "asset_symbol", document: doc.assetSymbol, recomputed: expectedAssetSymbol },
      ];
    }

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
        gradeQuantile: doc.gradeQuantile,
        minimumQualifyingGrade: doc.minimumQualifyingGrade,
        delegationInput: doc.delegationInput,
        tallyDocVersion: doc.tallyDocVersion,
        // A mirror's `min_affirmative_support` and `min_unique_voters` are the document's own;
        // check (f) has already compared both against the re-read parameter set. Its sides come
        // from the ON-CHAIN option labels (check (a) compares the document's against them).
        mirror: doc.ballotSource
          ? {
              sides: mirrorSides,
              framework: doc.ballotSource.framework !== null,
            }
          : undefined,
      },
      doc.votes,
      weights,
    );
  } catch (e) {
    if (e instanceof GatewayError) return { kind: "unknown", reason: e.message };
    if (e instanceof DocumentError) return { kind: "malformed", reason: e.message };
    // The document's own register names something the ledger says it is not, or a position that
    // IS there cannot be read. Neither an infrastructure failure nor an arithmetic disagreement:
    // the stated weight rule cannot be applied to the ledger the document pins, so there is no
    // figure to disagree about. Reported as MALFORMED rather than as a discrepancy, because
    // calling it a discrepancy would accuse a publisher of arithmetic they never got to do.
    if (e instanceof WeightRuleError) return { kind: "malformed", reason: e.message };
    throw e;
  }

  const differences = [
    ...consistencyDifferences,
    ...mirrorDifferences,
    ...assetSymbolDifferences,
    ...compareFigures(doc, derived),
  ];
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
