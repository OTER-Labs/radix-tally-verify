/**
 * The tally document, parsed and checked.
 *
 * The shape is derived from the reference engine's `compute_tally` — the field set it
 * writes is the contract — not from guesswork. Fields the verifier only needs to carry (they
 * are hashed but not recomputable off-ledger, like the ballots themselves, the title, or the
 * creation-time `eligible_voting_power`) stay in the raw object; fields the verdict is
 * derived from are parsed into `Dec` here so a malformed number fails fast as a MALFORMED
 * document instead of surfacing later as an arithmetic surprise.
 */

import { compareUtf8 } from "./canonical.ts";
import { Dec } from "./decimal.ts";
import { DELEGATION_REFUSALS } from "./delegation.ts";
import type { DelegationRefusal, SnapshotDelegation } from "./delegation.ts";
import type { Json } from "./canonical.ts";
import { asArray, asObject, asString } from "./gateway.ts";
import { GRADES } from "./verdict.ts";
import type { GradeQuantile } from "./verdict.ts";
import type {
  ConcentratedPoolSources,
  NativePoolSources,
  WeightSources,
} from "./weights.ts";

/**
 * The document version this verifier is written against.
 *
 * The versions this field set has travelled through, and what each added:
 *
 *   - **15** — the DAO-controlled-funds bar (framework 47ceb27, charter §5): the top-level
 *     `excluded_accounts` register and the per-ballot `excluded` flag; plus
 *     `majority_judgment.grade_quantile`, and invalid MJ ballots no longer counting toward
 *     Participation.
 *   - **16** — the LSULP leg: `weight_sources.lsulp`, a named component+resource pair valued at
 *     the component's `dex_valuation_xrd` over the resource's total supply.
 *   - **17** — the two concentrated-liquidity legs: `weight_sources.precision_pools` (Ociswap
 *     `PrecisionPool`) and `weight_sources.shape_pools` (CaviarNine `QuantaSwap`). The first
 *     version that counts a non-fungible.
 *   - **18** — delegation: `weight_sources.delegation`, the `delegation_input` and `delegations`
 *     reports, `delegated_weight_total`, and the per-ballot `delegated_weight` /
 *     `effective_weight` split.
 *   - **19** — `weight_set_version` and `excluded_set_version`: the ON-LEDGER versions of the
 *     register and the bar that the consultation registry pinned at creation, so the two
 *     embedded lists can be fetched by version and checked against the sets they claim to be.
 *   - **20** — the approval test is INCLUSIVE: `approve * 100 >= decisive * threshold_pc` where
 *     it used to be `>`, plus an explicit `decisive > 0` guard so a consultation with no
 *     decisive vote is not approved by `0 >= 0`. No shape change from v19.
 *
 *   - **mirror tallies** (`plan-w1-mirror-tallies.md` §3) — the additive `ballot_source` block
 *     that turns a document into a reproduction of an official Radix DAO Temperature Check or
 *     Proposal, with its own `mirror_doc_version` (currently 1) so it can grow independently of
 *     `TALLY_DOC_VERSION`. No bump here: bumping 20 for this would trip the on-chain
 *     `weight_source_set` gate for a field that is purely additive. See `src/mirror.ts`.
 *
 * No document is REFUSED for its version. Verification is driven by field presence, so one
 * written before any of these takes the absent-means-default path on each field and verifies
 * byte-identically to how it did before that version existed. The constant states which revision
 * the field set below tracks, not which ones it turns away.
 *
 * The v19→v20 change is the one thing field presence cannot express, because it is a COMPARISON
 * rather than a field — so the version number itself is read, and only for that. See
 * `approvalBarIsInclusive` in `src/verdict.ts`: each document's `approved` is recomputed under
 * the comparison in force when it was settled, exactly as each Majority Judgment result is
 * recomputed at the Grade Quantile it publishes. A verifier that applied today's comparison to
 * every document would report correct historical tallies as lies.
 */
export const TALLY_DOC_VERSION = 20;

/**
 * The two kinds of official Radix DAO vote a mirror document can reproduce (`plan-w1-mirror-tallies.md`
 * §3, §6).
 */
export type MirrorKind = "temperature_check" | "proposal";

/** The document's claim about what the OFFICIAL rule (liquid XRD only) found — recomputed and
 * compared against the same absolute `official_quorum` / `official_approval_threshold`. */
export interface OfficialRuleClaim {
  rule: string;
  totals: Dec[];
  totalWeight: Dec;
  quorumMet: boolean;
  approved: boolean;
}

/**
 * The per-leg gap between the OTER-rule total and the official-rule total (mirror-tally
 * `weight_delta_by_source`) — what each non-liquid-XRD source, plus delegation, added on top of
 * the official rule's plain balance read.
 */
export interface WeightDeltaBySource {
  lsu: Dec;
  poolUnits: Dec;
  lsulp: Dec;
  precisionPools: Dec;
  shapePools: Dec;
  delegationNet: Dec;
}

/**
 * The additive `ballot_source` block (plan `plan-w1-mirror-tallies.md` §3) that turns an ordinary
 * v20 tally document into a MIRROR of an official Radix DAO Temperature Check or Proposal.
 *
 * Presence, not a flag, is what makes a document a mirror (`TallyDocument.isMirror`) — the same
 * field-presence discipline every other leg in this file follows. Nothing here changes
 * `TALLY_DOC_VERSION`: the block is additive, so a document carrying it still parses and verifies
 * as an ordinary v20 document for every field this block does not itself add, per §3's own
 * statement that the top-level fields "carry the OTER-rule result exactly as a Poll would."
 */
export interface BallotSource {
  mirrorDocVersion: number;
  component: string;
  blueprint: string;
  kind: MirrorKind;
  officialId: number;
  officialStart: number;
  officialDeadline: number;
  officialQuorum: Dec;
  officialApprovalThreshold: Dec;
  officialVoteCount: number;
  officialRevoteCount: number;
  ballotCount: number;
  ballotStateVersion: number;
  ballotsOutsideWindow: number;
  officialRule: OfficialRuleClaim;
  weightDeltaBySource: WeightDeltaBySource;
}

/** The document could not be read as a tally document at all. Maps to exit 4, distinct from
 * all three verification outcomes: this is about the input, not about the tally. */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

export interface TallyVote {
  account: string;
  selection: number[];
  /**
   * The weight the document CLAIMS this account had — its OWN snapshot weight, never including
   * anything delegated to it. The recomputation replaces it.
   */
  weight: Dec;
  /**
   * The document's CLAIM that this ballot was barred under the DAO-controlled-funds rule. Like
   * `weight`, a claim and not an input: the recomputation derives the flag from the document's
   * own `excluded_accounts` register and compares. Absent (every v14 document) is false.
   */
  excluded: boolean;
  /**
   * What OTHER accounts asked this ballot to carry (v18). Present only when the delegation leg
   * was in force; `null` on any earlier document, and on a barred ballot, which is refused as a
   * delegate before any weight is assigned — printing a zero there would suggest nobody had
   * tried.
   */
  delegatedWeight: Dec | null;
  /** `weight + delegated_weight` — what this ballot actually carried (v18). */
  effectiveWeight: Dec | null;
}

/** One entry of the document's published `delegations` resolution. */
export interface PublishedDelegation {
  delegator: string;
  delegate: string;
  /** The DELEGATOR's own snapshot weight — what this delegation was worth, counted or not. */
  weight: Dec;
  counted: boolean;
  reason: DelegationRefusal | null;
}

export interface TallyDocument {
  /** The document exactly as given, for re-serialization and re-hashing. */
  raw: Json;
  /**
   * The document's own `tally_doc_version`.
   *
   * Not a gate on whether the document is verifiable — every version this tool has ever handled
   * still verifies, and the field set is read by presence. It is carried for the one rule that
   * a field's presence cannot express: which approval comparison the `approved` figure was
   * settled under. See `approvalBarIsInclusive` in `src/verdict.ts`.
   *
   * `null` when the document publishes none, which pins the recomputation to the pre-v20
   * comparison rather than to the current one.
   */
  tallyDocVersion: number | null;
  consultationId: string;
  kind: string;
  snapshotStateVersion: number;
  weightSources: WeightSources;
  /**
   * Accounts the DAO controls, whose balances may not be voted (framework 47ceb27, charter §5).
   * Carried inside the hashed document for exactly the reason `weight_sources` is: it is not
   * recomputable from Gateway state, and a challenger who applied a different list would
   * recompute a different tally and blame the arithmetic. `[]` when nothing is barred, which is
   * also what an absent field (any v14 document) means.
   */
  excludedAccounts: string[];
  /**
   * The ON-LEDGER versions of the register and the bar that the consultation registry pinned on
   * this consultation at creation (v19).
   *
   * Carried, not recomputed. Their job is to let someone fetch those two sets by version from
   * the registry and check that the lists this document EMBEDS are the ones it claims — a check
   * that needs the registry, not the Gateway state endpoints this tool reads. `null` on any
   * document written before v19.
   */
  weightSetVersion: number | null;
  excludedSetVersion: number | null;
  votes: TallyVote[];
  /**
   * The delegations in force at the snapshot (v18) — a trusted input, `null` when the leg was
   * off. See `src/delegation.ts`.
   */
  delegationInput: SnapshotDelegation[] | null;
  /** The published resolution (v18) — a claim, recomputed and compared. `null` when off. */
  delegations: PublishedDelegation[] | null;
  /** Total weight that reached a ballot by delegation (v18). `null` when off. */
  delegatedWeightTotal: Dec | null;
  totals: Dec[];
  totalWeight: Dec;
  abstainWeight: Dec;
  voterCount: number;
  quorum: Dec;
  approvalThresholdPc: Dec;
  minAffirmativeSupport: Dec;
  minUniqueVoters: number;
  quorumMet: boolean;
  masMet: boolean | null;
  seats: number;
  seatRule: string | null;
  majorityJudgment: Json;
  /**
   * The Grade Quantile the document publishes in `majority_judgment.grade_quantile` — the exact
   * fraction its qualifying grades were settled at.
   *
   * Not a claim to be checked against something else, the way `weight` and `excluded` are: it is
   * an INPUT to the recomputation. Framework §6.5 requires it on every MJ result precisely so a
   * stored result stays recomputable under the rule that produced it, and a verifier that
   * recomputed a v14 election under today's quantile would report a correct historical tally as
   * a lie. `null` when the document publishes none — see `VerdictSpec.gradeQuantile`.
   */
  gradeQuantile: GradeQuantile | null;
  winners: number[] | null;
  withdrawnExcluded: number[] | null;
  approveWeight: Dec | null;
  rejectWeight: Dec | null;
  approved: boolean | null;
  /**
   * The mirror-tally block (`plan-w1-mirror-tallies.md` §3), or `null` on an ordinary document.
   * `isMirror` is exactly `ballotSource !== null` — presence is the switch, not a separate flag
   * that could disagree with it.
   */
  ballotSource: BallotSource | null;
  isMirror: boolean;
}

function fail(field: string, why: string): never {
  throw new DocumentError(`tally document: field ${field} ${why}`);
}

function reqObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("(root)", "is not a JSON object");
  }
  return raw as Record<string, unknown>;
}

function reqString(doc: Record<string, unknown>, field: string): string {
  const v = asString(doc[field]);
  if (v === null) fail(field, "is missing or not a string");
  return v;
}

function reqDec(doc: Record<string, unknown>, field: string): Dec {
  const s = asString(doc[field]);
  if (s === null) fail(field, "is missing or not a Decimal string");
  try {
    return Dec.parse(s);
  } catch (e) {
    fail(field, `is not a canonical Decimal: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function optDec(doc: Record<string, unknown>, field: string): Dec | null {
  const v = doc[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") fail(field, "is neither null nor a Decimal string");
  try {
    return Dec.parse(v);
  } catch (e) {
    fail(field, `is not a canonical Decimal: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** An integer field that arrived in a later version: absent is `null`, not an error. */
function optInt(doc: Record<string, unknown>, field: string): number | null {
  const v = doc[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    fail(field, "is neither absent nor a safe integer");
  }
  return v;
}

function reqInt(doc: Record<string, unknown>, field: string): number {
  const v = doc[field];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    fail(field, "is missing or not a safe integer");
  }
  return v as number;
}

function reqBool(doc: Record<string, unknown>, field: string): boolean {
  const v = doc[field];
  if (typeof v !== "boolean") fail(field, "is missing or not a boolean");
  return v;
}

function optBool(doc: Record<string, unknown>, field: string): boolean | null {
  const v = doc[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "boolean") fail(field, "is neither null nor a boolean");
  return v;
}

function optIntArray(v: unknown, field: string): number[] | null {
  if (v === null || v === undefined) return null;
  const arr = asArray(v);
  const out: number[] = [];
  for (const x of arr) {
    if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) {
      fail(field, "contains a non-integer or negative index");
    }
    out.push(x);
  }
  return out;
}

function parseWeightSources(raw: unknown): WeightSources {
  // The register mirrors the reference engine's serde shape: {"native_pools":{"mode":...}},
  // with an absent register meaning the default (all native pools).
  const ws = asObject(raw);
  const np = asObject(ws["native_pools"]);
  const mode = asString(np["mode"]) ?? "all";
  const nativePools = ((): NativePoolSources => {
    switch (mode) {
      case "off":
        return { mode: "off" };
      case "all":
        return { mode: "all" };
      case "allowlist": {
        const pools = asArray(np["pools"]).map((p) => {
          const s = asString(p);
          if (s === null) fail("weight_sources.native_pools.pools", "contains a non-string");
          return s;
        });
        return { mode: "allowlist", pools };
      }
      default:
        // A typo'd mode is an error, not a fallback to the default: a tally silently verified
        // under the wrong register weighs the wrong electorate.
        return fail("weight_sources.native_pools.mode", `has unknown mode ${JSON.stringify(mode)}`);
    }
  })();

  const out: WeightSources = { native_pools: nativePools };

  // The LSULP leg (tally document v16). ABSENT means off — a v15 document, or a v16 register
  // that never enabled it, verifies identically. Serialized only when named, so its presence
  // always carries the exact pair.
  const lsulpRaw = ws["lsulp"];
  if (lsulpRaw !== undefined && lsulpRaw !== null) {
    const lp = asObject(lsulpRaw);
    const lpMode = asString(lp["mode"]) ?? "";
    switch (lpMode) {
      case "off":
        break;
      case "component": {
        const component = asString(lp["component"]);
        const resource = asString(lp["resource"]);
        if (component === null || component === "") {
          fail("weight_sources.lsulp.component", "is missing or not a string");
        }
        if (resource === null || resource === "") {
          fail("weight_sources.lsulp.resource", "is missing or not a string");
        }
        out.lsulp = { mode: "component", component, resource };
        break;
      }
      default:
        // Same discipline as native_pools: an unknown mode is an error. There is deliberately
        // no discovery mode — the pair is named or the leg is off.
        fail("weight_sources.lsulp.mode", `has unknown mode ${JSON.stringify(lpMode)}`);
    }
  }

  // The two concentrated-liquidity legs (v17). Same shape as each other and same discipline as
  // the LSULP leg: absent is off, named-or-off is the only pair of options, an unknown mode is
  // an error rather than a fallback.
  const precision = parseConcentratedLeg(ws["precision_pools"], "precision_pools");
  if (precision !== null) out.precision_pools = precision;
  const shape = parseConcentratedLeg(ws["shape_pools"], "shape_pools");
  if (shape !== null) out.shape_pools = shape;

  // The delegation leg (v18). ONE named component or nothing — a second register would be a
  // second answer to the question of who casts an account's weight.
  const delegationRaw = ws["delegation"];
  if (delegationRaw !== undefined && delegationRaw !== null) {
    const dl = asObject(delegationRaw);
    const dlMode = asString(dl["mode"]) ?? "";
    switch (dlMode) {
      case "off":
        break;
      case "component": {
        const component = asString(dl["component"]);
        if (component === null || component === "") {
          fail("weight_sources.delegation.component", "is missing or not a string");
        }
        out.delegation = { mode: "component", component };
        break;
      }
      default:
        fail("weight_sources.delegation.mode", `has unknown mode ${JSON.stringify(dlMode)}`);
    }
  }

  return out;
}

/** One concentrated-liquidity leg of the register: absent/off, or an allowlist of components. */
function parseConcentratedLeg(raw: unknown, name: string): ConcentratedPoolSources | null {
  if (raw === undefined || raw === null) return null;
  const o = asObject(raw);
  const mode = asString(o["mode"]) ?? "";
  switch (mode) {
    case "off":
      return null;
    case "allowlist": {
      const pools = asArray(o["pools"]).map((p) => {
        const s = asString(p);
        if (s === null) fail(`weight_sources.${name}.pools`, "contains a non-string");
        return s;
      });
      return { mode: "allowlist", pools };
    }
    default:
      // There is deliberately no discovery mode for these: a position's value is the output of a
      // formula over state fields the component reports about itself, and both halves of its
      // metadata round trip live in address spaces anyone may occupy.
      return fail(`weight_sources.${name}.mode`, `has unknown mode ${JSON.stringify(mode)}`);
  }
}

/**
 * The delegations IN FORCE at the snapshot — the document's `delegation_input`.
 *
 * `null` when the leg was off, which a reader must be able to tell from `[]` ("the leg was on
 * and nobody had delegated"). A TRUSTED INPUT, not a recomputation: see `src/delegation.ts` on
 * why the snapshot half of the leg is not derivable from Gateway historical state.
 */
function parseDelegationInput(raw: unknown): SnapshotDelegation[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) fail("delegation_input", "is neither null nor an array");
  return raw.map((entry, i) => {
    const o = asObject(entry);
    const delegator = asString(o["delegator"]);
    const delegate = asString(o["delegate"]);
    if (delegator === null) fail(`delegation_input[${i}].delegator`, "is missing or not a string");
    if (delegate === null) fail(`delegation_input[${i}].delegate`, "is missing or not a string");
    const declined = o["delegate_declined"];
    if (typeof declined !== "boolean") {
      fail(`delegation_input[${i}].delegate_declined`, "is missing or not a boolean");
    }
    return { delegator, delegate, delegateDeclined: declined };
  });
}

/**
 * The RESOLUTION the document publishes: every delegation in force, whether it counted, and why
 * not. Unlike `delegation_input` this is a CLAIM — it is recomputed from the input, the ballots
 * and the bar, and compared entry by entry.
 */
function parseDelegations(raw: unknown): PublishedDelegation[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) fail("delegations", "is neither null nor an array");
  return raw.map((entry, i) => {
    const o = asObject(entry);
    const delegator = asString(o["delegator"]);
    const delegate = asString(o["delegate"]);
    if (delegator === null) fail(`delegations[${i}].delegator`, "is missing or not a string");
    if (delegate === null) fail(`delegations[${i}].delegate`, "is missing or not a string");
    const weightStr = asString(o["weight"]);
    if (weightStr === null) fail(`delegations[${i}].weight`, "is missing or not a Decimal string");
    let weight: Dec;
    try {
      weight = Dec.parse(weightStr);
    } catch (e) {
      fail(
        `delegations[${i}].weight`,
        `is not a canonical Decimal: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const countedRaw = o["counted"];
    if (typeof countedRaw !== "boolean") {
      fail(`delegations[${i}].counted`, "is missing or not a boolean");
    }
    const reasonRaw = o["reason"];
    if (reasonRaw !== null && reasonRaw !== undefined && typeof reasonRaw !== "string") {
      fail(`delegations[${i}].reason`, "is neither null nor a string");
    }
    const reason = typeof reasonRaw === "string" ? reasonRaw : null;
    // The tokens are a closed set the reference implementation publishes. An unrecognised one is
    // refused rather than carried: comparing against a string nobody emits would silently pass.
    if (reason !== null && !(DELEGATION_REFUSALS as readonly string[]).includes(reason)) {
      fail(`delegations[${i}].reason`, `has unknown refusal token ${JSON.stringify(reason)}`);
    }
    return {
      delegator,
      delegate,
      weight,
      counted: countedRaw,
      reason: reason as DelegationRefusal | null,
    };
  });
}

/**
 * The DAO-controlled-funds register: a list of account addresses, ascending by UTF-8 bytes.
 *
 * Absent is `[]` and not an error — every v14 document predates the bar, and treating its
 * absence as a malformed document would make this verifier unable to check the tallies it was
 * written to check.
 *
 * Order is enforced, strictly. The array is content under the canonical encoding (rule 4: arrays
 * keep their order), so two documents listing the same accounts in different orders hash
 * differently while barring exactly the same ballots. A document whose register is out of order
 * is therefore not one the reference implementation can have produced, and a duplicate entry —
 * which strict ascent also rejects — is a second way to write the same list. Accepting either
 * would be accepting a document whose hash nobody else will reproduce.
 */
function parseExcludedAccounts(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) fail("excluded_accounts", "is neither absent nor an array");
  const out: string[] = [];
  for (const entry of raw) {
    const s = asString(entry);
    if (s === null) fail("excluded_accounts", "contains a non-string");
    out.push(s);
  }
  for (let i = 1; i < out.length; i++) {
    if (compareUtf8(out[i - 1] as string, out[i] as string) >= 0) {
      fail(
        "excluded_accounts",
        `is not strictly ascending by UTF-8 bytes at index ${i} ` +
          `(${JSON.stringify(out[i - 1])} then ${JSON.stringify(out[i])})`,
      );
    }
  }
  return out;
}

/**
 * The Grade Quantile published inside `majority_judgment`, as an exact fraction.
 *
 * Absent is `null` and not an error: the field arrived in v15, and refusing every document
 * written before it would make this verifier unable to check the tallies it was written to
 * check. Absent means three-fifths, which is what the engine of that vintage applied.
 *
 * Present, it must be two integers. A decimal is refused outright rather than read as a
 * near-enough approximation — the entire reason the framework specifies a numerator and a
 * denominator is that 0.6 has no exact binary representation, and a verifier willing to accept
 * `0.6` here would be willing to disagree with the ledger in the last place. A denominator of
 * zero is refused for the same reason: it is not a fraction, and a comparison against it is not
 * the comparison the rule describes.
 *
 * A numerator greater than the denominator is NOT refused. It is a quantile no candidate can
 * reach, which settles every one of them at the lowest grade — strange, but well defined, and
 * this verifier's job is to reproduce the document's stated rule rather than to hold opinions
 * about which fractions the framework ought to have allowed.
 */
function parseGradeQuantile(mjRaw: unknown): GradeQuantile | null {
  if (typeof mjRaw !== "object" || mjRaw === null || Array.isArray(mjRaw)) return null;
  const q = (mjRaw as Record<string, unknown>)["grade_quantile"];
  if (q === null || q === undefined) return null;
  if (typeof q !== "object" || Array.isArray(q)) {
    fail("majority_judgment.grade_quantile", "is neither absent nor an object");
  }
  const o = q as Record<string, unknown>;
  const num = o["numerator"];
  const den = o["denominator"];
  if (typeof num !== "number" || !Number.isSafeInteger(num) || num < 0) {
    fail(
      "majority_judgment.grade_quantile.numerator",
      "is missing or not a non-negative integer — the quantile is an exact fraction, never a decimal",
    );
  }
  if (typeof den !== "number" || !Number.isSafeInteger(den) || den <= 0) {
    fail(
      "majority_judgment.grade_quantile.denominator",
      "is missing or not a positive integer — the quantile is an exact fraction, never a decimal",
    );
  }
  return { numerator: num, denominator: den };
}

const MIRROR_KINDS: readonly MirrorKind[] = ["temperature_check", "proposal"];

function parseOfficialRuleClaim(raw: unknown): OfficialRuleClaim {
  const o = asObject(raw);
  const rule = asString(o["rule"]);
  if (rule === null) fail("ballot_source.official_rule.rule", "is missing or not a string");
  const totalsRaw = asArray(o["totals"]);
  const totals = totalsRaw.map((t, i) => {
    const s = asString(t);
    if (s === null) fail(`ballot_source.official_rule.totals[${i}]`, "is not a Decimal string");
    try {
      return Dec.parse(s);
    } catch (e) {
      fail(
        `ballot_source.official_rule.totals[${i}]`,
        `is not a canonical Decimal: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
  return {
    rule: rule as string,
    totals,
    totalWeight: reqDec(o, "total_weight"),
    quorumMet: reqBool(o, "quorum_met"),
    approved: reqBool(o, "approved"),
  };
}

function parseWeightDeltaBySource(raw: unknown): WeightDeltaBySource {
  const o = asObject(raw);
  return {
    lsu: reqDec(o, "lsu"),
    poolUnits: reqDec(o, "pool_units"),
    lsulp: reqDec(o, "lsulp"),
    precisionPools: reqDec(o, "precision_pools"),
    shapePools: reqDec(o, "shape_pools"),
    delegationNet: reqDec(o, "delegation_net"),
  };
}

/**
 * The `ballot_source` block (§3): absent is `null`, exactly like every other additive leg in
 * this file — a document written before mirror tallies existed, or an ordinary Poll/Binding/
 * Election document, verifies exactly as it always did.
 */
function parseBallotSource(raw: unknown): BallotSource | null {
  if (raw === null || raw === undefined) return null;
  const o = asObject(raw);
  const kind = asString(o["kind"]);
  if (kind === null || !(MIRROR_KINDS as readonly string[]).includes(kind)) {
    fail("ballot_source.kind", `is missing or not one of ${JSON.stringify(MIRROR_KINDS)}`);
  }
  return {
    mirrorDocVersion: reqInt(o, "mirror_doc_version"),
    component: reqString(o, "component"),
    blueprint: reqString(o, "blueprint"),
    kind: kind as MirrorKind,
    officialId: reqInt(o, "official_id"),
    officialStart: reqInt(o, "official_start"),
    officialDeadline: reqInt(o, "official_deadline"),
    officialQuorum: reqDec(o, "official_quorum"),
    officialApprovalThreshold: reqDec(o, "official_approval_threshold"),
    officialVoteCount: reqInt(o, "official_vote_count"),
    officialRevoteCount: reqInt(o, "official_revote_count"),
    ballotCount: reqInt(o, "ballot_count"),
    ballotStateVersion: reqInt(o, "ballot_state_version"),
    ballotsOutsideWindow: reqInt(o, "ballots_outside_window"),
    officialRule: parseOfficialRuleClaim(o["official_rule"]),
    weightDeltaBySource: parseWeightDeltaBySource(o["weight_delta_by_source"]),
  };
}

/**
 * Parse and validate a tally document. Accepts either the bare document or the API envelope
 * (`{"document": …, "document_hash_blake2b": …}`); the envelope's hash is returned alongside
 * so the caller does not have to re-implement the unwrapping.
 */
export function parseTallyDocument(input: unknown): { doc: TallyDocument; envelopeHash: string | null } {
  let raw = reqObject(input);
  let envelopeHash: string | null = null;
  if ("document" in raw && raw["document"] !== undefined) {
    envelopeHash = asString(raw["document_hash_blake2b"]);
    raw = reqObject(raw["document"]);
  }

  const kind = reqString(raw, "kind");
  const seatRule = asString(raw["seat_rule"]);
  const totalsRaw = asArray(raw["totals"]);
  if (totalsRaw.length === 0 && kind !== "Election") {
    fail("totals", "is missing or empty");
  }
  const totals = totalsRaw.map((t, i) => {
    const s = asString(t);
    if (s === null) fail(`totals[${i}]`, "is not a Decimal string");
    try {
      return Dec.parse(s);
    } catch (e) {
      fail(`totals[${i}]`, `is not a canonical Decimal: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Under Majority Judgment the option space is five entries per candidate — the ballot
  // grades every candidate and `totals` is the raw per-(candidate, grade) distribution. A
  // width that is not a multiple of five cannot be an MJ election's totals.
  if (kind === "Election" && seatRule === "MajorityJudgment" && totals.length % GRADES.length !== 0) {
    fail("totals", `has length ${totals.length}, not a multiple of ${GRADES.length} under MajorityJudgment`);
  }

  const votes: TallyVote[] = asArray(raw["votes"]).map((v, i) => {
    const o = asObject(v);
    const account = asString(o["account"]);
    if (account === null) fail(`votes[${i}].account`, "is missing or not a string");
    const selection = optIntArray(o["selection"], `votes[${i}].selection`) ?? [];
    const weightStr = asString(o["weight"]);
    if (weightStr === null) fail(`votes[${i}].weight`, "is missing or not a Decimal string");
    let weight: Dec;
    try {
      weight = Dec.parse(weightStr);
    } catch (e) {
      fail(`votes[${i}].weight`, `is not a canonical Decimal: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A barred ballot stays in `votes` — that is the point of the design, since a verifier that
    // never saw the ballot could not confirm the exclusion was applied. Absent is false, which
    // is every ballot in every v14 document.
    const excludedRaw = o["excluded"];
    if (excludedRaw !== undefined && excludedRaw !== null && typeof excludedRaw !== "boolean") {
      fail(`votes[${i}].excluded`, "is neither absent nor a boolean");
    }
    // v18: the own/delegated split. Both present or both absent — the reference implementation
    // writes them together, so one without the other is a document nobody can have produced.
    const delegatedWeight = optDec(o, "delegated_weight");
    const effectiveWeight = optDec(o, "effective_weight");
    if ((delegatedWeight === null) !== (effectiveWeight === null)) {
      fail(
        `votes[${i}]`,
        "carries exactly one of delegated_weight and effective_weight — they are written together",
      );
    }
    return {
      account: account as string,
      selection,
      weight,
      excluded: excludedRaw === true,
      delegatedWeight,
      effectiveWeight,
    };
  });

  const snapshotStateVersion = reqInt(raw, "snapshot_state_version");
  if (snapshotStateVersion <= 0) fail("snapshot_state_version", "is not a positive state version");

  const winnersRaw = raw["winners"];
  const winners = winnersRaw === null || winnersRaw === undefined
    ? null
    : (optIntArray(winnersRaw, "winners") as number[]);

  const ballotSource = parseBallotSource(raw["ballot_source"]);

  const doc: TallyDocument = {
    raw: raw as Json,
    tallyDocVersion: optInt(raw, "tally_doc_version"),
    consultationId: reqString(raw, "consultation_id"),
    kind,
    snapshotStateVersion,
    weightSources: parseWeightSources(raw["weight_sources"]),
    excludedAccounts: parseExcludedAccounts(raw["excluded_accounts"]),
    weightSetVersion: optInt(raw, "weight_set_version"),
    excludedSetVersion: optInt(raw, "excluded_set_version"),
    votes,
    delegationInput: parseDelegationInput(raw["delegation_input"]),
    delegations: parseDelegations(raw["delegations"]),
    delegatedWeightTotal: optDec(raw, "delegated_weight_total"),
    totals,
    totalWeight: reqDec(raw, "total_weight"),
    abstainWeight: reqDec(raw, "abstain_weight"),
    voterCount: reqInt(raw, "voter_count"),
    quorum: reqDec(raw, "quorum"),
    approvalThresholdPc: reqDec(raw, "approval_threshold_pc"),
    minAffirmativeSupport: reqDec(raw, "min_affirmative_support"),
    minUniqueVoters: reqInt(raw, "min_unique_voters"),
    quorumMet: reqBool(raw, "quorum_met"),
    masMet: optBool(raw, "mas_met"),
    seats: reqInt(raw, "seats"),
    seatRule,
    majorityJudgment: (raw["majority_judgment"] ?? null) as Json,
    gradeQuantile: parseGradeQuantile(raw["majority_judgment"]),
    winners,
    withdrawnExcluded: optIntArray(raw["withdrawn_excluded"], "withdrawn_excluded"),
    approveWeight: optDec(raw, "approve_weight"),
    rejectWeight: optDec(raw, "reject_weight"),
    approved: optBool(raw, "approved"),
    ballotSource,
    isMirror: ballotSource !== null,
  };
  return { doc, envelopeHash };
}
