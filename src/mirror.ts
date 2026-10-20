/**
 * Mirror-tally verification: the extra checks a document carrying `ballot_source` gets on top of
 * the ordinary pipeline.
 *
 * A mirror document publishes TWO tallies of the SAME on-chain ballots — the official Radix DAO
 * Consultation App's own rule (direct XRD, every validator's LSUs, LSULP and its static DEX
 * allowlist) and this platform's `WEIGHT_RULE` (the same four families under the DAO's versioned
 * on-ledger register) — so that the only thing the two can disagree about is which positions
 * each list names. Both take ONE bar, the official vote's own: the absolute `quorum` and
 * `approval_threshold` of its parameter-set leg, plus the governance framework's Minimum
 * Affirmative Support and distinct-voter floor for that set (`src/framework.ts`). Both decide by
 * LABEL: a Temperature Check's sides are For and Against, a Proposal's are its Approve, Reject and
 * optional Abstain options wherever they sit — the labels the entry carries ON CHAIN, never the
 * document's — and a Proposal with any other label set, or a
 * multi-select one, decides nothing. Abstain counts toward quorum and stays outside the decisive
 * share. The top-level document fields (`votes`, `totals`,
 * `total_weight`, `quorum`, `approval_threshold_pc`, `approved`, …) already carry the OTER-rule
 * result exactly as an ordinary Poll/Binding document would, so `src/verify.ts`'s existing
 * pipeline checks that half — recompute the weights, re-derive the verdict, compare — completely
 * unchanged. What is unique to a mirror document, and lives here, is:
 *
 *   (a) **the ballots are not a trusted input any more.** For an ordinary document the ballot set
 *       is carried inside the hash and never independently re-derived (see the README's "What is
 *       not recomputed"). A mirror document's ballots ARE re-derivable — that is the whole point
 *       — by walking the official component's own state: `temperature_checks` / `proposals` KVS
 *       → the entry named by `official_id`, at `official_entry_state_version` → its `voters`
 *       KVS, at `ballot_state_version`. The two versions differ because a Temperature Check
 *       records its outcome and continuation after its deadline, so after its last ballot: the
 *       entry as it stood at `ballot_state_version` carries neither. The ballot re-read is
 *       compared against `doc.votes` account by account, and the entry's own metadata against
 *       what `ballot_source` claims: the `quorum` / `approval_threshold` of its parameter-set
 *       leg, the set's `{id, label, version, variant}`, `start` / `deadline` / `vote_count` /
 *       `revote_count`, a Temperature Check's `snapshot`, recorded `outcome` and `continuation`,
 *       and a Proposal's `max_selections` and its `vote_options` labels in id order against the
 *       document's `options` — the labels both legs take their sides from, since ballots match
 *       by index. The entry is read in the Governance 1.0.0 shape, by
 *       field name; a shape it does not describe is refused, naming the path. The weight
 *       snapshot's anchor is checked too: `snapshot_state_version` must be the state version the
 *       Gateway's timestamp selector resolves the entry's snapshot Instant to (its `start` on a
 *       Proposal) — the same selector (d) uses.
 *   (b) **the official rule** — the app's own policy, recomputed with the SAME weight engine the
 *       OTER rule uses but handed the ALLOWLIST as its register (`src/allowlist.ts`), summed per
 *       option over the same ballots, gated by the same absolute `official_quorum` /
 *       `official_approval_threshold` `ballot_source` carries, and compared against
 *       `ballot_source.official_rule` — its totals, its `totals_by_source` split, and the
 *       `allowlist_version` / `allowlist_hash` naming the list it claims to have applied. The
 *       list comes from this package's own `data/` copy, never from the document: a document
 *       verified against a list it supplied itself would be verified against nothing.
 *   (d) **`ballots_outside_window`** — how many re-read ballots landed outside the vote's own
 *       window. Both bounds are resolved from `official_start` / `official_deadline` via the SAME
 *       Gateway timestamp selector the reference engine's own state-version lookup uses, ported
 *       here rather than approximated — see `resolveStateVersionAtTimestamp` and
 *       `ballotsOutsideWindow` below, whose open-window convention (an unbounded upper bound
 *       while `official_deadline` is still in the future) mirrors the engine's exactly. The
 *       window opens at the vote's `start`, never at `official_snapshot`: the snapshot fixes the
 *       weights only, and a vote that weighs at an earlier round's snapshot (a Majority Judgment
 *       rerun) still opens for ballots at its own start.
 *   (e) **`weight_delta_by_source`** — the per-source gap between the two rules, OTER-rule
 *       weight minus official-rule weight over the same participating accounts. Zero on every
 *       source where the DAO's register and the app's allowlist name the same positions; signed,
 *       because "our register counts a position theirs does not" and the reverse are different
 *       facts about the same two lists.
 *   (f) **the framework bar** — eligible voting power, MAS and the distinct-voter floor,
 *       re-derived from the RE-READ parameter-set id and quorum (never the document's): eligible
 *       is `quorum * 100 / quorum_pc`, a lower bound within `100 / quorum_pc` of the true figure,
 *       and MAS is `eligible * mas_pc / 100`. Compared against the top-level
 *       `eligible_voting_power`, `min_affirmative_support` and `min_unique_voters`, and against
 *       the `ballot_source.framework` row the document names. A set the framework table does not
 *       name has no bar: `eligible_voting_power` `"0"`, `framework` null, and no verdict.
 *   (g) **`oter_register_scope`** — which register the OTER-rule leg may apply on the official
 *       component's network. The register is a registry's, and every entry it names is an
 *       address on the registry's network. `"full"` exactly when the component is on that same
 *       network; otherwise `"network_independent"`, under which every leg that names an address
 *       is off (`scopedRegister`), so no register address is ever sent to the other network's
 *       gateway. Delegation is off under both. The document's `weight_sources` must equal the
 *       register so derived, and it is that DERIVED register — never the document's — that
 *       (c) and (e) recompute the OTER leg under. See `checkRegisterScope`.
 *
 * Every mismatch here is reported through the same `Difference` shape `src/verify.ts` already
 * uses for the ordinary (c) figures, tagged `ballot_source.(a|b|d|e|f|g) …` so the letter that
 * failed is legible in the output without a second Outcome kind.
 */

import type { BallotSource, MirrorKind, PinnedWeightSet, RegisterScope, TallyDocument } from "./document.ts";
import { canonicalize } from "./canonical.ts";
import type { Json } from "./canonical.ts";
import { Dec } from "./decimal.ts";
import { officialAllowlistFor } from "./allowlist.ts";
import { ELIGIBLE_DERIVATION, FRAMEWORK_SOURCE, decisionSides, frameworkFor } from "./framework.ts";
import type { Sides } from "./framework.ts";
import { GatewayError, asArray, asObject, asString } from "./gateway.ts";
import type { GatewayClient } from "./gateway.ts";
import { stateField } from "./concentrated.ts";
import { WeightRuleError } from "./concentrated.ts";
import {
  GRADES,
  THREE_FIFTHS,
  allocateSeatsMajorityJudgment,
  bindingApproved,
  decodeMjBallot,
  majorityJudgmentJson,
} from "./verdict.ts";
import type { Ballot, GradeQuantile } from "./verdict.ts";
import { computeAccountWeightBreakdown, networkOf, registerAddresses, serializeWeightSources } from "./weights.ts";
import type { WeightBreakdown, WeightSources } from "./weights.ts";
import type { Difference } from "./verify.ts";

/**
 * The official rule, in the document's own words — the sentence every v3 mirror carries in
 * `ballot_source.official_rule.rule`. It is inside the hash, so a document that paraphrased it
 * would commit a different sentence than the one its author published.
 */
export const OFFICIAL_RULE_TEXT =
  "The Radix DAO Consultation App's own rule at snapshot_state_version: direct XRD at par, plus " +
  "the stake units of every validator at their underlying XRD value, plus LSULP at its " +
  "underlying liquid-staked XRD value, plus the XRD, LSU and LSULP side of each position on the " +
  "app's static DEX allowlist (Ociswap V1/V2 precision receipts and Basic/Flex pool units, " +
  "CaviarNine Simple/HLP pool units and Shape receipts, DefiPlaza Base/Quote pool units) — the " +
  "allowlist identified by allowlist_version and allowlist_hash below. The other token in a pair " +
  "adds no voting power. Voters only: no delegation, and none of this platform's own charter " +
  "bar, which that vote does not have.";

/** Keys per `/state/key-value-store/data` request; pages per `/state/key-value-store/keys` walk. */
const KVS_DATA_CHUNK = 100;
const MAX_KVS_PAGES = 500;

/** `ballot_source.kind` -> the component's own field name for that register. */
function kvsFieldFor(kind: MirrorKind): string {
  switch (kind) {
    case "temperature_check":
      return "temperature_checks";
    case "proposal":
      return "proposals";
    case "majority_judgment_election":
    case "majority_judgment_election_rerun":
      return "majority_judgment_elections";
  }
}

/** The round name a Majority Judgment kind mirrors. */
function roundNameFor(kind: MirrorKind): "RoundOne" | "Rerun" | null {
  if (kind === "majority_judgment_election") return "RoundOne";
  if (kind === "majority_judgment_election_rerun") return "Rerun";
  return null;
}

function isMjKind(kind: MirrorKind): boolean {
  return kind === "majority_judgment_election" || kind === "majority_judgment_election_rerun";
}

/** One `field_name` out of a Tuple/Struct-shaped `programmatic_json` node. */
function tupleField(node: unknown, name: string): Record<string, unknown> | null {
  const fields = asArray(asObject(node)["fields"]);
  for (const f of fields) {
    const o = asObject(f);
    if (asString(o["field_name"]) === name) return o;
  }
  return null;
}

function tupleFieldString(node: unknown, name: string): string | null {
  const f = tupleField(node, name);
  return f === null ? null : asString(f["value"]);
}

function tupleFieldInt(node: unknown, name: string, field: string): number {
  const s = tupleFieldString(node, name);
  if (s === null || !/^-?\d+$/.test(s)) {
    throw new WeightRuleError(`${field} has no readable ${name} field`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throw new WeightRuleError(`${field}.${name} (${s}) is outside the safe integer range`);
  }
  return n;
}

function tupleFieldDec(node: unknown, name: string, field: string): Dec {
  const s = tupleFieldString(node, name);
  if (s === null) throw new WeightRuleError(`${field} has no readable ${name} field`);
  try {
    return Dec.parse(s);
  } catch (e) {
    throw new WeightRuleError(
      `${field}.${name} is not a canonical Decimal: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Page a key-value store's whole key set at a state version, as the raw `programmatic_json` key nodes. */
async function pageKvsKeys(
  gw: GatewayClient,
  kvsAddress: string,
  stateVersion: number,
  what: string,
): Promise<unknown[]> {
  const keys: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    const resp = asObject(await gw.keyValueStoreKeys(kvsAddress, cursor, stateVersion));
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(`gateway refused ${what} keys of ${kvsAddress} at sv ${stateVersion}: ${message}`);
    }
    for (const item of asArray(resp["items"])) {
      keys.push(asObject(asObject(item)["key"])["programmatic_json"]);
    }
    const next = asString(resp["next_cursor"]);
    if (next === null) break;
    if (next === cursor) {
      throw new GatewayError(`gateway returned a non-advancing ${what} cursor for ${kvsAddress} at sv ${stateVersion}`);
    }
    if (page + 1 >= MAX_KVS_PAGES) {
      throw new GatewayError(`${what} of ${kvsAddress} at sv ${stateVersion} did not end within ${MAX_KVS_PAGES} pages`);
    }
    cursor = next;
  }
  return keys;
}

/** One official Temperature Check / Proposal entry, re-read at `official_entry_state_version`. */
export interface OfficialEntry {
  blueprint: string;
  votersKvsAddress: string;
  /** The vote's own snapshot of its parameter set: `id`, `label`, `version`, and the
   * `parameters` variant (`Standard` or `MajorityJudgment`). */
  parameterSet: { id: string; label: string; version: number; variant: string };
  /** `quorum` and `approval_threshold` of the vote's own leg of that set — `temperature_check`
   * for a Temperature Check, `proposal` for a Proposal. */
  quorum: Dec;
  approvalThreshold: Dec;
  /** A Temperature Check's own `snapshot` Instant; `null` on a Proposal, which carries none. */
  snapshot: number | null;
  start: number;
  deadline: number;
  voteCount: number;
  revoteCount: number;
  /** A Temperature Check's recorded outcome (`Passed` / `Failed` and when); `null` until one is
   * recorded, and on every Proposal. */
  outcome: { result: string; recordedAt: number } | null;
  /** What a Temperature Check was elevated to; `null` when it has not been, and on a Proposal. */
  continuation: { kind: string; id: number } | null;
  /** A Proposal's `max_selections`; `null` when single choice, and on every Temperature Check. */
  maxSelections: number | null;
  /** A Proposal's `vote_options` labels, verbatim, in `ProposalVoteOptionId` order — the order
   * its ballots index; `null` on a Temperature Check, whose sides are fixed. On a Majority
   * Judgment round, the candidates' display names in id order. */
  voteOptions: string[] | null;
  /** The `last_updated_at_state_version` the entry carried at the read, so a document's
   * `official_entry_state_version` can be checked against it. */
  lastUpdatedAtStateVersion: number | null;
  /** Majority Judgment only: which round the entry held. */
  round: "RoundOne" | "Rerun" | null;
  /** Majority Judgment only: the election's role id and candidate references, in id order. */
  roleId: string | null;
  candidateReferences: string[] | null;
  /** Majority Judgment only: the recorded tie order for this round, or null. */
  tieResolution: number[] | null;
  /** Majority Judgment only: the round's minimum median grade, as a `GRADES` ordinal — the
   * floor both legs are allocated under. */
  minimumGradeIndex: number | null;
  /** Majority Judgment only: the seat count the election's Temperature Check declares. */
  seats: number | null;
}

/**
 * A Proposal's `vote_options`: `Array<Tuple ProposalVoteOption { id: ProposalVoteOptionId(U32),
 * label: String }>`, returned as the labels in id order. The ids must be exactly `0..n-1`, since
 * a ballot's selection is an id and the published `options` are indexed by it; any other shape is
 * refused, naming the path.
 */
function readVoteOptions(value: unknown, field: string): string[] {
  const f = tupleField(value, "vote_options");
  if (f === null) throw new WeightRuleError(`${field} has no readable vote_options field`);
  const elements = asArray(f["elements"]);
  const labels: (string | undefined)[] = new Array(elements.length);
  elements.forEach((element, i) => {
    const at = `${field} vote_options[${i}]`;
    const idNode = tupleField(element, "id");
    if (idNode === null) throw new WeightRuleError(`${at} has no readable id field`);
    const idRaw = asString(idNode["value"]) ?? asString(asObject(asArray(idNode["fields"])[0])["value"]);
    if (idRaw === null || !/^\d+$/.test(idRaw)) throw new WeightRuleError(`${at}.id does not parse as U32`);
    const id = Number(idRaw);
    if (id >= elements.length || labels[id] !== undefined) {
      throw new WeightRuleError(`${at}.id ${id} is not a distinct id in 0..${elements.length - 1}`);
    }
    const label = tupleFieldString(element, "label");
    if (label === null) throw new WeightRuleError(`${at} has no readable label field`);
    labels[id] = label;
  });
  return labels as string[];
}

/** An Enum-shaped `programmatic_json` field: its `variant_name` and the node itself. */
function enumNode(node: unknown, name: string): { variant: string; fields: unknown } | null {
  const f = tupleField(node, name);
  if (f === null) return null;
  const variant = asString(f["variant_name"]);
  return variant === null ? null : { variant, fields: f };
}

/** An `Option<T>` field: `null` for `None`, the inner value node for `Some`, refused otherwise. */
function optionInner(node: unknown, name: string, field: string): Record<string, unknown> | null {
  const e = enumNode(node, name);
  if (e === null) throw new WeightRuleError(`${field} has no readable ${name} field`);
  if (e.variant === "None") return null;
  if (e.variant !== "Some") throw new WeightRuleError(`${field}.${name} is not an Option`);
  const inner = asArray(asObject(e.fields)["fields"])[0];
  if (inner === undefined) throw new WeightRuleError(`${field}.${name} is Some with no value`);
  return asObject(inner);
}

/** An unsigned integer carried as a `programmatic_json` scalar node's string `value`. */
function scalarInt(node: unknown, what: string): number {
  const s = asString(asObject(node)["value"]);
  if (s === null || !/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) {
    throw new WeightRuleError(`${what} is not a readable unsigned integer`);
  }
  return Number(s);
}

/** The official `Grade` variants by ordinal: Poor = 0 … Excellent = 4. This platform's
 * `GRADES` run the other way (Excellent = 0), so the ordinal is reversed once, here. */
const OFFICIAL_GRADE_NAMES = ["Poor", "Acceptable", "Good", "VeryGood", "Excellent"] as const;

/** An official grade enum's score, only when `variant_id` and `variant_name` agree. A
 * disagreement is refused rather than resolved by either half. */
function officialGradeScore(node: unknown, what: string): number {
  const o = asObject(node);
  const idRaw = asString(o["variant_id"]) ?? (typeof o["variant_id"] === "number" ? String(o["variant_id"]) : null);
  const name = asString(o["variant_name"]);
  if (idRaw === null || !/^\d+$/.test(idRaw)) {
    throw new WeightRuleError(`${what} has no readable grade variant_id`);
  }
  const score = Number(idRaw);
  if (OFFICIAL_GRADE_NAMES[score] !== name) {
    throw new WeightRuleError(
      `${what} grade variant_id ${idRaw} and variant_name ${JSON.stringify(name)} disagree`,
    );
  }
  return score;
}

/** An official grade name -> this platform's `GRADES` ordinal. */
export function officialGradeIndex(name: string): number | null {
  const score = (OFFICIAL_GRADE_NAMES as readonly string[]).indexOf(name);
  return score < 0 ? null : GRADES.length - 1 - score;
}

/** A `U32` newtype element, whether the Gateway renders the scalar bare or one level down. */
function optionIndex(node: unknown): number | null {
  const o = asObject(node);
  const raw = asString(o["value"]);
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return null;
    return Number(raw);
  }
  const inner = asArray(o["fields"])[0];
  return inner === undefined ? null : optionIndex(inner);
}

/**
 * `MajorityJudgmentVoterEntry.grades`: `(candidate_id, official score)` pairs -> a selection in
 * the tally's `candidate * 5 + grade` space, sorted. This is the whole ordinal reversal — this
 * platform's index 0 is Excellent, the official score 4 is. Duplicates and missing candidates
 * are left to the tally's validity rule, so an invalid ballot is still reported rather than
 * dropped here.
 */
function decodeMjSelection(value: unknown, field: string): number[] {
  const grades = tupleField(value, "grades");
  if (grades === null) throw new WeightRuleError(`${field} has no readable grades field`);
  const out: number[] = [];
  for (const element of asArray(grades["elements"])) {
    const candidateNode = tupleField(element, "candidate_id");
    if (candidateNode === null) throw new WeightRuleError(`${field} grade has no candidate_id`);
    const candidate = optionIndex(candidateNode);
    if (candidate === null) throw new WeightRuleError(`${field} candidate_id does not parse as U32`);
    const gradeNode = tupleField(element, "grade");
    if (gradeNode === null) throw new WeightRuleError(`${field} grade has no grade field`);
    const score = officialGradeScore(gradeNode, `${field} candidate ${candidate}`);
    out.push(candidate * GRADES.length + (GRADES.length - 1 - score));
  }
  return out.sort((a, b) => a - b);
}

/** One ballot, re-read from the `voters` key-value store at `ballot_state_version`. */
export interface OfficialBallot {
  account: string;
  selection: number[];
  lastUpdatedAtStateVersion: number | null;
}

/** A KVS data entry's own `last_updated_at_state_version`, or null when it carries none. */
function entryStateVersion(entry: unknown): number | null {
  const raw = asObject(entry)["last_updated_at_state_version"];
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) {
    return Number(raw);
  }
  return null;
}

/** Locate one entry in a KVS by its U64 key, returning the key node the data read needs. */
async function findKvsEntryKey(
  gw: GatewayClient,
  kvsAddress: string,
  id: number,
  stateVersion: number,
  what: string,
): Promise<unknown> {
  const keys = await pageKvsKeys(gw, kvsAddress, stateVersion, what);
  const matched = keys.find((k) => {
    const v = asString(asObject(k)["value"]);
    return v !== null && /^\d+$/.test(v) && Number(v) === id;
  });
  if (matched === undefined) {
    throw new WeightRuleError(`no ${what} entry ${id} exists in ${kvsAddress} at sv ${stateVersion}`);
  }
  return matched;
}

/** The `programmatic_json` value of one KVS entry, refused when the read carries none. */
async function readKvsEntryValue(
  gw: GatewayClient,
  kvsAddress: string,
  key: unknown,
  stateVersion: number,
  what: string,
): Promise<{ value: unknown; stateVersion: number | null }> {
  const resp = asObject(await gw.keyValueStoreData(kvsAddress, [{ key_json: key }], stateVersion));
  const message = asString(resp["message"]);
  if (message !== null) {
    throw new GatewayError(`gateway refused ${what} data of ${kvsAddress} at sv ${stateVersion}: ${message}`);
  }
  const entry = asArray(resp["entries"])[0];
  if (entry === undefined) {
    throw new WeightRuleError(`${what} of ${kvsAddress} has no value at sv ${stateVersion}`);
  }
  return {
    value: asObject(asObject(entry)["value"])["programmatic_json"],
    stateVersion: entryStateVersion(entry),
  };
}

/**
 * One Majority Judgment round's entry: `majority_judgment_elections` -> the election named by
 * `official_id` -> the `round_one` / `rerun` it holds. The election carries no parameter set of
 * its own: the round's parameter set, candidates, role and seat count come from the Temperature
 * Check the election names, exactly as the official component's own schema splits them.
 *
 * The round's own fields are the vote's: snapshot, window, quorum, minimum median grade, voters
 * and counts. Its `minimum_median_grade` is the floor both legs are allocated under, which is
 * why it is decoded here rather than assumed to be "Good".
 */
async function readMjEntry(
  gw: GatewayClient,
  componentItem: Record<string, unknown>,
  election: unknown,
  kind: MirrorKind,
  officialId: number,
  stateVersion: number,
  field: string,
  blueprint: string,
  lastUpdatedAtStateVersion: number | null,
): Promise<OfficialEntry> {
  const roundName = roundNameFor(kind) as "RoundOne" | "Rerun";
  const roundField = roundName === "RoundOne" ? "round_one" : "rerun";
  const round = optionInner(election, roundField, field);
  if (round === null) {
    throw new WeightRuleError(`${field} holds no ${roundField}`);
  }
  const minimumGradeNode = tupleField(round, "minimum_median_grade");
  if (minimumGradeNode === null) {
    throw new WeightRuleError(`${field} ${roundField} has no readable minimum_median_grade`);
  }
  const gradeName = asString(minimumGradeNode["variant_name"]);
  if (gradeName === null) {
    throw new WeightRuleError(`${field} ${roundField} minimum_median_grade is not a grade`);
  }
  // Decode the grade as an official enum first: id and name must agree.
  officialGradeScore(minimumGradeNode, `${field} ${roundField} minimum_median_grade`);
  const minimumGradeIndex = officialGradeIndex(gradeName);
  if (minimumGradeIndex === null) {
    throw new WeightRuleError(`${field} ${roundField} minimum_median_grade ${JSON.stringify(gradeName)} is not a grade`);
  }

  const votersKvsAddress = tupleFieldString(round, "voters");
  if (votersKvsAddress === null) {
    throw new WeightRuleError(`${field} ${roundField} has no readable voters field`);
  }

  // The election's tie resolution names the round it applies to.
  const tieInner = optionInner(election, "tie_resolution", field);
  let tieResolution: number[] | null = null;
  if (tieInner !== null) {
    const roundNode = tupleField(tieInner, "round");
    const tieRound = roundNode === null ? null : asString(roundNode["variant_name"]);
    if (tieRound !== "RoundOne" && tieRound !== "Rerun") {
      throw new WeightRuleError(`${field} tie_resolution.round is ${JSON.stringify(tieRound)}`);
    }
    if (tieRound === roundName) {
      const idsField = tupleField(tieInner, "ordered_candidate_ids");
      if (idsField === null) {
        throw new WeightRuleError(`${field} tie_resolution has no ordered_candidate_ids`);
      }
      tieResolution = asArray(idsField["elements"]).map((element, i) => {
        const id = optionIndex(element);
        if (id === null) {
          throw new WeightRuleError(`${field} tie_resolution.ordered_candidate_ids[${i}] does not parse as U32`);
        }
        return id;
      });
    }
  }

  // The Temperature Check the election was opened from: text, parameter set, candidates, role
  // and seat count. It carries the MajorityJudgment parameter-set variant.
  const temperatureCheckId = tupleFieldInt(election, "temperature_check_id", field);
  const tcKvs = stateField(componentItem, "temperature_checks");
  if (tcKvs === null) {
    throw new WeightRuleError(`component state has no temperature_checks field for election ${officialId}`);
  }
  const tcKey = await findKvsEntryKey(gw, tcKvs, temperatureCheckId, stateVersion, "temperature_checks");
  const tc = await readKvsEntryValue(gw, tcKvs, tcKey, stateVersion, "temperature_checks");
  const tcField = `${field} temperature_check ${temperatureCheckId}`;

  const set = tupleField(tc.value, "parameter_set");
  if (set === null) throw new WeightRuleError(`${tcField} has no readable parameter_set field`);
  const params = enumNode(set, "parameters");
  if (params === null || params.variant !== "MajorityJudgment") {
    throw new WeightRuleError(`${tcField}: parameter_set.parameters is not MajorityJudgment`);
  }
  const setId = tupleFieldString(set, "id");
  const setLabel = tupleFieldString(set, "label");
  if (setId === null) throw new WeightRuleError(`${tcField} has no readable parameter_set.id field`);
  if (setLabel === null) throw new WeightRuleError(`${tcField} has no readable parameter_set.label field`);

  const follow = enumNode(tc.value, "follow_up");
  if (follow === null || follow.variant !== "MajorityJudgmentElection") {
    throw new WeightRuleError(`${tcField}: follow_up is not MajorityJudgmentElection`);
  }
  const roleId = tupleFieldString(follow.fields, "role_id");
  if (roleId === null) throw new WeightRuleError(`${tcField} follow_up has no readable role_id`);
  const seatCount = tupleFieldInt(follow.fields, "seat_count", `${tcField} follow_up`);
  const candidatesField = tupleField(follow.fields, "candidates");
  if (candidatesField === null) {
    throw new WeightRuleError(`${tcField} follow_up has no readable candidates`);
  }
  const candidates: Array<{ id: number; name: string; reference: string }> = [];
  for (const [index, element] of asArray(candidatesField["elements"]).entries()) {
    const id = optionIndex(tupleField(element, "id"));
    const name = tupleFieldString(element, "display_name");
    const reference = tupleFieldString(element, "reference");
    if (id === null || name === null || reference === null) {
      throw new WeightRuleError(`${tcField} follow_up.candidates[${index}] is not readable`);
    }
    candidates.push({ id, name, reference });
  }
  candidates.sort((a, b) => a.id - b.id);
  if (candidates.some((candidate, i) => candidate.id !== i)) {
    throw new WeightRuleError(`${tcField} follow_up.candidates: ids do not run 0..${candidates.length - 1}`);
  }

  return {
    blueprint,
    votersKvsAddress,
    parameterSet: {
      id: setId,
      label: setLabel,
      version: tupleFieldInt(set, "version", `${tcField} parameter_set`),
      variant: "MajorityJudgment",
    },
    quorum: tupleFieldDec(round, "quorum", `${field} ${roundField}`),
    // Majority Judgment has no approval threshold; the document publishes "0".
    approvalThreshold: Dec.ZERO,
    snapshot: tupleFieldInt(round, "snapshot", `${field} ${roundField}`),
    start: tupleFieldInt(round, "start", `${field} ${roundField}`),
    deadline: tupleFieldInt(round, "deadline", `${field} ${roundField}`),
    voteCount: tupleFieldInt(round, "vote_count", `${field} ${roundField}`),
    revoteCount: tupleFieldInt(round, "revote_count", `${field} ${roundField}`),
    outcome: null,
    continuation: null,
    maxSelections: null,
    voteOptions: candidates.map((candidate) => candidate.name),
    lastUpdatedAtStateVersion,
    round: roundName,
    roleId,
    candidateReferences: candidates.map((candidate) => candidate.reference),
    tieResolution,
    minimumGradeIndex,
    seats: seatCount,
  };
}

/**
 * component state → `temperature_checks` / `proposals` KVS → the entry named by `official_id`.
 *
 * The entry is located by paging the register's keys and decoding each as a U64 until one
 * matches — the register carries only a handful of entries in practice (single-digit counts of
 * Temperature Checks and Proposals), so a full page walk is cheap, and it means the
 * matched key is used EXACTLY as the keys endpoint returned it for the follow-up data read,
 * rather than this module guessing the Gateway's `programmatic_json` encoding of a U64 key.
 */
export async function readOfficialEntry(
  gw: GatewayClient,
  component: string,
  kind: MirrorKind,
  officialId: number,
  stateVersion: number,
): Promise<OfficialEntry> {
  const detailsResp = asObject(
    await gw.entityDetails([component], stateVersion, { global: false, explicitMetadata: [] }),
  );
  const message = asString(detailsResp["message"]);
  if (message !== null) {
    throw new GatewayError(`gateway refused component details of ${component} at sv ${stateVersion}: ${message}`);
  }
  const item = asArray(detailsResp["items"])
    .map((i) => asObject(i))
    .find((i) => asString(i["address"]) === component);
  if (item === undefined) {
    throw new WeightRuleError(
      `ballot_source names component ${component}, which the gateway did not return at sv ${stateVersion}`,
    );
  }
  const blueprint = asString(asObject(item["details"])["blueprint_name"]) ?? "";

  const fieldName = kvsFieldFor(kind);
  const registerKvs = stateField(item, fieldName);
  if (registerKvs === null) {
    throw new WeightRuleError(`component ${component} has no ${fieldName} state field`);
  }

  const keys = await pageKvsKeys(gw, registerKvs, stateVersion, fieldName);
  const matched = keys.find((k) => {
    const v = asString(asObject(k)["value"]);
    return v !== null && /^\d+$/.test(v) && Number(v) === officialId;
  });
  if (matched === undefined) {
    throw new WeightRuleError(
      `ballot_source names official_id ${officialId} under kind ${kind}, but no such entry exists ` +
        `in ${component}'s ${fieldName} at sv ${stateVersion}`,
    );
  }

  const dataResp = asObject(
    await gw.keyValueStoreData(registerKvs, [{ key_json: matched }], stateVersion),
  );
  const dataMessage = asString(dataResp["message"]);
  if (dataMessage !== null) {
    throw new GatewayError(`gateway refused ${fieldName} data of ${registerKvs} at sv ${stateVersion}: ${dataMessage}`);
  }
  const entry = asArray(dataResp["entries"])[0];
  if (entry === undefined) {
    throw new WeightRuleError(
      `${fieldName} entry ${officialId} of ${component} has no value at sv ${stateVersion}`,
    );
  }
  const value = asObject(asObject(entry)["value"])["programmatic_json"];
  const field = `${kind} ${officialId} of ${component}`;
  const lastUpdatedAtStateVersion = entryStateVersion(entry);

  if (isMjKind(kind)) {
    return readMjEntry(
      gw,
      item,
      value,
      kind,
      officialId,
      stateVersion,
      field,
      blueprint,
      lastUpdatedAtStateVersion,
    );
  }

  const votersKvsAddress = tupleFieldString(value, "voters");
  if (votersKvsAddress === null) {
    throw new WeightRuleError(`${field} has no readable voters field`);
  }

  // The Governance 1.0.0 shape: quorum and threshold live on the vote's own snapshot of its
  // parameter set, under the leg for its kind. A Temperature Check reads the temperature_check
  // leg of either variant; a Proposal exists only under a Standard set and reads its proposal leg.
  const set = tupleField(value, "parameter_set");
  if (set === null) throw new WeightRuleError(`${field} has no readable parameter_set field`);
  const params = enumNode(set, "parameters");
  if (params === null || (params.variant !== "Standard" && params.variant !== "MajorityJudgment")) {
    throw new WeightRuleError(`${field} has no readable parameter_set.parameters variant`);
  }
  const legName = kind === "temperature_check" ? "temperature_check" : "proposal";
  if (legName === "proposal" && params.variant !== "Standard") {
    throw new WeightRuleError(`${field}: parameter_set.parameters: variant ${params.variant} has no proposal leg`);
  }
  const leg = tupleField(params.fields, legName);
  if (leg === null) throw new WeightRuleError(`${field} has no parameter_set.parameters.${params.variant}.${legName}`);
  const legField = `${field} parameter_set.parameters.${params.variant}.${legName}`;
  const setId = tupleFieldString(set, "id");
  if (setId === null) throw new WeightRuleError(`${field} has no readable parameter_set.id field`);
  const setLabel = tupleFieldString(set, "label");
  if (setLabel === null) throw new WeightRuleError(`${field} has no readable parameter_set.label field`);
  const parameterSet = {
    id: setId,
    label: setLabel,
    version: tupleFieldInt(set, "version", `${field} parameter_set`),
    variant: params.variant,
  };

  const common = {
    blueprint,
    votersKvsAddress,
    parameterSet,
    quorum: tupleFieldDec(leg, "quorum", legField),
    approvalThreshold: tupleFieldDec(leg, "approval_threshold", legField),
    start: tupleFieldInt(value, "start", field),
    deadline: tupleFieldInt(value, "deadline", field),
    voteCount: tupleFieldInt(value, "vote_count", field),
    revoteCount: tupleFieldInt(value, "revote_count", field),
  };

  if (kind === "temperature_check") {
    const outcomeInner = optionInner(value, "outcome", field);
    let outcome: { result: string; recordedAt: number } | null = null;
    if (outcomeInner !== null) {
      const result = asString(outcomeInner["variant_name"]);
      if (result !== "Passed" && result !== "Failed") {
        throw new WeightRuleError(`${field}: outcome: unknown variant ${result ?? "(none)"}`);
      }
      outcome = { result, recordedAt: tupleFieldInt(outcomeInner, "recorded_at", `${field} outcome.${result}`) };
    }
    const continuationInner = optionInner(value, "continuation", field);
    let continuation: { kind: string; id: number } | null = null;
    if (continuationInner !== null) {
      const variant = asString(continuationInner["variant_name"]);
      if (variant !== "Proposal" && variant !== "MajorityJudgmentElection") {
        throw new WeightRuleError(`${field}: continuation: unknown variant ${variant ?? "(none)"}`);
      }
      continuation = {
        kind: variant === "Proposal" ? "proposal" : "majority_judgment_election",
        id: scalarInt(asArray(continuationInner["fields"])[0], `${field} continuation.${variant}`),
      };
    }
    return {
      ...common,
      snapshot: tupleFieldInt(value, "snapshot", field),
      outcome,
      continuation,
      maxSelections: null,
      voteOptions: null,
      lastUpdatedAtStateVersion,
      round: null,
      roleId: null,
      candidateReferences: null,
      tieResolution: null,
      minimumGradeIndex: null,
      seats: null,
    };
  }

  const maxInner = optionInner(value, "max_selections", field);
  return {
    ...common,
    snapshot: null,
    outcome: null,
    continuation: null,
    maxSelections: maxInner === null ? null : scalarInt(maxInner, `${field} max_selections`),
    voteOptions: readVoteOptions(value, field),
    lastUpdatedAtStateVersion,
    round: null,
    roleId: null,
    candidateReferences: null,
    tieResolution: null,
    minimumGradeIndex: null,
    seats: null,
  };
}

/**
 * Decode one ballot's `programmatic_json` value into a selection over Poll option order
 * `["Against", "For"]` (Temperature Check) or raw option indices (Proposal).
 *
 * Temperature Check: `TemperatureCheckVoterEntry { vote: Enum TemperatureCheckVote }`, `For` is
 * variant 0 and `Against` is variant 1 in the official component's own enum — the OPPOSITE of the
 * Poll option order this mirror publishes, so the mapping inverts: `For` -> `[1]`, `Against` ->
 * `[0]`.
 * Proposal: `ProposalVoterEntry { options: Array<Tuple ProposalVoteOptionId(U32)> }` — each
 * element is that option's index directly.
 */
function decodeSelection(value: unknown, kind: MirrorKind, field: string): number[] {
  if (kind === "temperature_check") {
    const vote = tupleField(value, "vote");
    if (vote === null) throw new WeightRuleError(`${field} has no readable vote field`);
    const variantName = asString(vote["variant_name"]);
    const variantIdRaw = asString(vote["variant_id"]);
    const variantId = variantName === "For" ? 0
      : variantName === "Against" ? 1
      : variantIdRaw !== null && /^\d+$/.test(variantIdRaw) ? Number(variantIdRaw)
      : null;
    if (variantId === 0) return [1]; // For -> Poll option index 1
    if (variantId === 1) return [0]; // Against -> Poll option index 0
    throw new WeightRuleError(`${field} vote variant is neither For nor Against`);
  }
  if (isMjKind(kind)) return decodeMjSelection(value, field);
  const options = tupleField(value, "options");
  if (options === null) throw new WeightRuleError(`${field} has no readable options field`);
  const out: number[] = [];
  for (const element of asArray(options["elements"])) {
    const inner = asArray(asObject(element)["fields"])[0];
    const s = asString(asObject(inner)["value"]);
    if (s === null || !/^\d+$/.test(s)) {
      throw new WeightRuleError(`${field} has an option index that does not parse as U32`);
    }
    out.push(Number(s));
  }
  return out.sort((a, b) => a - b);
}

/** The whole `voters` key-value store at `ballot_state_version`: every ballot, latest per account. */
export async function readOfficialBallots(
  gw: GatewayClient,
  votersKvsAddress: string,
  kind: MirrorKind,
  stateVersion: number,
): Promise<OfficialBallot[]> {
  const keys = await pageKvsKeys(gw, votersKvsAddress, stateVersion, "voters");
  const ballots: OfficialBallot[] = [];
  for (let i = 0; i < keys.length; i += KVS_DATA_CHUNK) {
    const chunk = keys.slice(i, i + KVS_DATA_CHUNK).map((k) => ({ key_json: k }));
    const resp = asObject(await gw.keyValueStoreData(votersKvsAddress, chunk, stateVersion));
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(`gateway refused voters data of ${votersKvsAddress} at sv ${stateVersion}: ${message}`);
    }
    for (const entry of asArray(resp["entries"])) {
      const o = asObject(entry);
      const account = asString(asObject(asObject(o["key"])["programmatic_json"])["value"]);
      if (account === null) continue;
      const value = asObject(o["value"])["programmatic_json"];
      const selection = decodeSelection(value, kind, `voter ${account} of ${votersKvsAddress}`);
      const svRaw = o["last_updated_at_state_version"];
      const lastUpdatedAtStateVersion =
        typeof svRaw === "number" && Number.isSafeInteger(svRaw)
          ? svRaw
          : typeof svRaw === "string" && /^\d+$/.test(svRaw)
            ? Number(svRaw)
            : null;
      ballots.push({ account, selection, lastUpdatedAtStateVersion });
    }
  }
  return ballots;
}

/** Sort a selection for set-style comparison — ballot content, not ballot order, is what matters. */
function sortedSelection(selection: number[]): number[] {
  return [...selection].sort((a, b) => a - b);
}

function decStr(v: Dec | undefined): string {
  return v === undefined ? "0" : v.toString();
}

/** Sum one breakdown map's five listed legs (plus liquid XRD) over the accounts a filter admits. */
function sumLegs(
  breakdown: Map<string, WeightBreakdown>,
  accounts: string[],
  admit: (account: string) => boolean,
): { xrd: Dec; lsu: Dec; lsulp: Dec; poolUnits: Dec; precisionPools: Dec; shapePools: Dec } {
  const sum = {
    xrd: Dec.ZERO,
    lsu: Dec.ZERO,
    lsulp: Dec.ZERO,
    poolUnits: Dec.ZERO,
    precisionPools: Dec.ZERO,
    shapePools: Dec.ZERO,
  };
  for (const account of accounts) {
    if (!admit(account)) continue;
    const b = breakdown.get(account);
    if (b === undefined) continue;
    sum.xrd = sum.xrd.add(b.xrd);
    sum.lsu = sum.lsu.add(b.lsu);
    sum.lsulp = sum.lsulp.add(b.lsulp);
    sum.poolUnits = sum.poolUnits.add(b.poolUnits);
    sum.precisionPools = sum.precisionPools.add(b.precisionPools);
    sum.shapePools = sum.shapePools.add(b.shapePools);
  }
  return sum;
}

/**
 * The official rule, recomputed: the app's own weight function — direct XRD, every validator's
 * LSUs, LSULP and the allowlisted positions, which is what `weights` already holds because the
 * caller computed it under the ALLOWLIST as its register — summed per option.
 *
 * The official leg takes the same quorum and approval bar as the OTER leg: the official vote's
 * own absolute quorum and approval threshold, plus the framework's Minimum Affirmative Support
 * and distinct-voter floor for its parameter set. It does NOT take the OTER leg's
 * `excluded_accounts` bar: the official vote has no such bar, so every ballot counts here —
 * toward the totals, `total_weight` and the voter count — a barred account's included. An
 * Abstain ballot enters `total_weight` (and so quorum) like any other; only the Approve and
 * Reject sides enter the decisive share. `approved` is
 * `null` when the vote has no decision sides — a label set other than Approve/Reject(/Abstain),
 * a multi-select proposal, or a parameter set the framework table does not name.
 */
function officialRuleFigures(
  ballots: Map<string, number[]>,
  weights: Map<string, Dec>,
  optionCount: number,
  quorum: Dec,
  approvalThresholdPc: Dec,
  sides: Sides | null,
  mas: Dec,
  minUniqueVoters: number,
): { totals: Dec[]; totalWeight: Dec; quorumMet: boolean; approved: boolean | null } {
  const totals: Dec[] = Array.from({ length: optionCount }, () => Dec.ZERO);
  let totalWeight = Dec.ZERO;
  let voters = 0;
  for (const [account, selection] of ballots) {
    const weight = weights.get(account) ?? Dec.ZERO;
    voters++;
    totalWeight = totalWeight.add(weight);
    for (const idx of selection) {
      if (idx >= 0 && idx < optionCount) totals[idx] = (totals[idx] as Dec).add(weight);
    }
  }
  const quorumMet = totalWeight.gte(quorum) && voters >= minUniqueVoters;
  const approved =
    sides === null
      ? null
      : bindingApproved(
          totals[sides.approve] ?? Dec.ZERO,
          totals[sides.reject] ?? Dec.ZERO,
          approvalThresholdPc,
          mas,
          quorumMet,
          true, // mirror documents are always tally_doc_version 20+: inclusive comparison
        );
  return { totals, totalWeight, quorumMet, approved };
}

/**
 * The official leg of a Majority Judgment round, in the Election's own shape: the raw
 * per-(candidate, grade) totals over VALID ballots only, participation and quorum over valid
 * ballots only, and — when quorum is met — the seating under the round's own floor.
 *
 * An invalid ballot still reaches the allocator, because the allocator is what reports it in
 * `invalid_ballots`; it reaches no grade, no total, no participation and no voter count. The
 * official vote has no `excluded_accounts` bar, so every ballot is in the allocator's input.
 */
function officialMjFigures(
  ballots: Ballot[],
  optionCount: number,
  seats: number,
  quorum: Dec,
  minUniqueVoters: number,
  quantile: GradeQuantile,
  floor: number,
): {
  totals: Dec[];
  totalWeight: Dec;
  quorumMet: boolean;
  winners: number[] | null;
  majorityJudgment: Json;
} {
  const candidateCount = optionCount / GRADES.length;
  const totals: Dec[] = Array.from({ length: optionCount }, () => Dec.ZERO);
  let totalWeight = Dec.ZERO;
  let voters = 0;
  for (const ballot of ballots) {
    const weight = ballot.weight;
    if (decodeMjBallot(ballot.selection, candidateCount) === null) continue;
    voters++;
    totalWeight = totalWeight.add(weight);
    for (const idx of ballot.selection) {
      const t = totals[idx];
      if (t !== undefined) totals[idx] = t.add(weight);
    }
  }
  const quorumMet = totalWeight.gte(quorum) && voters >= minUniqueVoters;
  if (!quorumMet) {
    return { totals, totalWeight, quorumMet, winners: null, majorityJudgment: null };
  }
  const result = allocateSeatsMajorityJudgment(ballots, candidateCount, seats, [], quantile, floor);
  return {
    totals,
    totalWeight,
    quorumMet,
    winners: result.winners,
    majorityJudgment: majorityJudgmentJson(result, quantile, floor),
  };
}

/**
 * Unix seconds -> ISO 8601. The reference engine builds its timestamp with an RFC 3339
 * formatter that spells the UTC offset `+00:00`; `Date.toISOString()` spells it `Z`. Both are the same instant in the same standard, and the Gateway's timestamp
 * selector parses either — this is a spelling difference, not a semantic one.
 */
function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The last ledger state at or before `unixSeconds`, via the Gateway's timestamp selector.
 *
 * This is the SAME call the reference engine's own state-version lookup makes, ported rather
 * than approximated: XRD is used as the anchor address exactly as the engine uses the native XRD
 * resource, since any well-known entity works and the entity's own data is never read — only the
 * response envelope's `ledger_state.state_version` is wanted.
 */
async function resolveStateVersionAtTimestamp(
  gw: GatewayClient,
  xrdResource: string,
  unixSeconds: number,
): Promise<number> {
  const iso = isoFromUnixSeconds(unixSeconds);
  const resp = asObject(await gw.entityDetailsAtTimestamp(xrdResource, iso));
  const sv = asObject(resp["ledger_state"])["state_version"];
  if (typeof sv !== "number" || !Number.isSafeInteger(sv) || sv <= 0) {
    throw new GatewayError(
      `gateway did not resolve a state version for timestamp ${unixSeconds} (${iso}): ` +
        `${asString(resp["message"]) ?? "no message"}`,
    );
  }
  return sv;
}

/**
 * How many re-read ballots landed outside the window this document is pinned to, in
 * STATE-VERSION terms — ported from the reference engine's own outside-window count, not
 * approximated. Its stated reasoning, which this implementation keeps:
 *
 * "Compared as STATE VERSIONS rather than timestamps, because the gateway offers a
 * timestamp -> state-version selector and no cheap inverse: resolving one timestamp per ballot
 * would be one round trip per voter, where the two window bounds are two round trips for the
 * whole vote. The comparison is exact either way — state version is monotone in ledger time."
 *
 * Both bounds are themselves resolved from `official_start` / `official_deadline` by
 * {@link resolveStateVersionAtTimestamp} — the caller's job, not this pure function's, exactly as
 * the engine separates the comparison from the two timestamp lookups that produce its bounds.
 * `upperBoundSv` is `Number.MAX_SAFE_INTEGER` while the deadline is still in the future (the
 * engine uses its own signed-64-bit maximum as the same sentinel): there is no ledger state
 * after a future deadline to resolve, so an open vote reports zero late ballots rather than every
 * ballot as late.
 */
function ballotsOutsideWindow(ballots: OfficialBallot[], lowerBoundSv: number, upperBoundSv: number): number {
  let count = 0;
  for (const b of ballots) {
    if (b.lastUpdatedAtStateVersion === null) continue;
    if (b.lastUpdatedAtStateVersion < lowerBoundSv || b.lastUpdatedAtStateVersion > upperBoundSv) count++;
  }
  return count;
}

/**
 * The register the OTER-rule leg applies under `scope`, from the full pinned set.
 *
 * Delegation is off under both scopes: a mirror resolves none. Under `"network_independent"`
 * every leg that names an address goes off — `lsulp`, `precision_pools`, `shape_pools`, and a
 * `native_pools` allowlist, which turns off rather than widening into discovery (discovery would
 * count pools the register never admitted). `native_pools` in mode `all` stays: discovery names
 * nothing, it follows the pool units the voter holds on the ledger being read. Direct XRD and
 * every validator's stake units count under both, as always. The space legs (`fungible`,
 * `membership`) name a resource and go off with the rest; a mirror lives in the Radix/XRD space
 * and carries neither.
 */
export function scopedRegister(sources: WeightSources, scope: RegisterScope): WeightSources {
  const { delegation: _delegation, ...rest } = sources;
  if (scope === "full") return rest;
  return {
    native_pools: sources.native_pools.mode === "all" ? { mode: "all" } : { mode: "off" },
  };
}

/**
 * Check (g): the scope a mirror document claims, against the networks, and the register it
 * carries, against the one that scope derives. Pure — no gateway call — and run before any
 * weight walk, because its result is the register that walk is handed.
 *
 * The expected scope is `"full"` exactly when the official component's network equals the
 * network of the registry whose weight-source set `weight_set_version` names. That set, and its
 * registry's network, come from `pinned` when the caller supplies it. Without it, the document's
 * own `weight_sources` stands in for the set: any address it names is a registry entry and says
 * which network the registry is on, and a register that names nothing leaves the network unknown
 * — the claimed scope then stands, and the derived register names nothing either way.
 *
 * Returns the derived register (under the EXPECTED scope wherever the networks are known), which
 * names no address off the component's network, and the (g) differences.
 */
export function checkRegisterScope(
  doc: TallyDocument,
  pinned: PinnedWeightSet | null,
): { applied: WeightSources; differences: Difference[] } {
  const bs = doc.ballotSource;
  if (bs === null) return { applied: doc.weightSources, differences: [] };
  const differences: Difference[] = [];
  const check = (field: string, document: string, recomputed: string): void => {
    if (document !== recomputed) differences.push({ field, document, recomputed });
  };

  const componentNetwork = networkOf(bs.component);
  if (componentNetwork === null) {
    throw new WeightRuleError(`ballot_source.component ${bs.component} names no recognisable network`);
  }

  let registryNetwork: string | null;
  let full: WeightSources;
  if (pinned !== null) {
    check("ballot_source.(g) weight_set_version", String(doc.weightSetVersion), String(pinned.version));
    registryNetwork = pinned.network;
    full = pinned.sources;
  } else {
    const networks = new Set<string>();
    for (const address of registerAddresses(doc.weightSources)) {
      const on = networkOf(address);
      if (on === null) throw new WeightRuleError(`weight_sources names ${address}, which is on no recognisable network`);
      networks.add(on);
    }
    if (networks.size > 1) {
      throw new WeightRuleError(
        `weight_sources names addresses on more than one network (${[...networks].sort().join(", ")}); ` +
          `a register is one registry's, on one network`,
      );
    }
    registryNetwork = networks.size === 1 ? ([...networks][0] as string) : null;
    full = doc.weightSources;
  }

  const expected: RegisterScope | null =
    registryNetwork === null ? null : registryNetwork === componentNetwork ? "full" : "network_independent";
  if (expected !== null) check("ballot_source.(g) oter_register_scope", bs.oterRegisterScope, expected);

  const applied = scopedRegister(full, expected ?? bs.oterRegisterScope);
  check(
    "ballot_source.(g) weight_sources",
    canonicalize(serializeWeightSources(doc.weightSources) as unknown as Json),
    canonicalize(serializeWeightSources(applied) as unknown as Json),
  );
  return { applied, differences };
}

/** What the mirror checks found, and the decision sides both legs take. */
export interface MirrorChecks {
  differences: Difference[];
  /** The sides derived from the ON-CHAIN option labels (a Temperature Check's fixed For/Against),
   * never from the document's; `null` when the vote decides nothing. */
  sides: Sides | null;
}

/**
 * Every mirror-specific check (a), (b), (d), (e), (f) — everything `ballot_source` adds on top of the
 * ordinary v20 pipeline that `src/verify.ts` already runs unchanged for (c). No differences and no
 * sides on an ordinary document (`doc.isMirror` false); the caller is expected to skip calling
 * this in that case, but it is harmless either way. `oterSources` is the register (g) derived —
 * the one (e) weighs the OTER leg under; it defaults to the document's own. The returned `sides`
 * are the ones (c) decides the OTER leg by.
 */
export async function verifyMirrorBallots(
  doc: TallyDocument,
  gw: GatewayClient,
  xrdResource: string,
  oterSources: WeightSources = doc.weightSources,
): Promise<MirrorChecks> {
  const bs: BallotSource | null = doc.ballotSource;
  if (bs === null) return { differences: [], sides: null };
  const diffs: Difference[] = [];
  const check = (field: string, document: string, recomputed: string): void => {
    if (document !== recomputed) diffs.push({ field, document, recomputed });
  };

  // (a) component state -> the register -> the entry -> its own published parameters, all at
  // the state version the entry was read at. Not at `ballot_state_version`: a Temperature Check's
  // outcome and continuation are recorded after its deadline, so after its last ballot, and the
  // entry as it stood then carries neither.
  const entry = await readOfficialEntry(gw, bs.component, bs.kind, bs.officialId, bs.officialEntryStateVersion);
  check("ballot_source.(a) blueprint", bs.blueprint, entry.blueprint);
  // The version the document names is the entry's own last write, not merely the version the
  // read was pinned to: a read at a later state answers with the same entry and the same data,
  // so only the entry's own field can say whether the document's claim is true.
  if (entry.lastUpdatedAtStateVersion !== null) {
    check(
      "ballot_source.(a) official_entry_state_version",
      String(bs.officialEntryStateVersion),
      String(entry.lastUpdatedAtStateVersion),
    );
  }
  check("ballot_source.(a) official_quorum", bs.officialQuorum.toString(), entry.quorum.toString());
  check(
    "ballot_source.(a) official_approval_threshold",
    bs.officialApprovalThreshold.toString(),
    entry.approvalThreshold.toString(),
  );
  check("ballot_source.(a) official_start", String(bs.officialStart), String(entry.start));
  check("ballot_source.(a) official_deadline", String(bs.officialDeadline), String(entry.deadline));
  check("ballot_source.(a) official_vote_count", String(bs.officialVoteCount), String(entry.voteCount));
  check("ballot_source.(a) official_revote_count", String(bs.officialRevoteCount), String(entry.revoteCount));
  check("ballot_source.(a) official_parameter_set", canonicalize(bs.officialParameterSet as unknown as Json), canonicalize(entry.parameterSet as unknown as Json));
  check("ballot_source.(a) official_snapshot", String(bs.officialSnapshot), String(entry.snapshot ?? entry.start));
  check("ballot_source.(a) official_outcome", canonicalize(bs.officialOutcome as unknown as Json), canonicalize(entry.outcome as unknown as Json));
  check("ballot_source.(a) official_continuation", canonicalize(bs.officialContinuation as unknown as Json), canonicalize(entry.continuation as unknown as Json));
  check("ballot_source.(a) official_max_selections", String(bs.officialMaxSelections), String(entry.maxSelections));
  // A Proposal's option labels, verbatim and in id order. The sides are derived from the entry's
  // labels, never the document's: ballots match by index, so a document with Approve and Reject
  // swapped would otherwise re-derive its own inverted verdict and agree with itself.
  if (entry.voteOptions !== null) {
    check("ballot_source.(a) options", canonicalize(doc.options), canonicalize(entry.voteOptions));
  }
  if (isMjKind(bs.kind)) {
    check("ballot_source.(a) official_round", String(bs.officialRound), String(entry.round));
    check("ballot_source.(a) official_role_id", String(bs.officialRoleId), String(entry.roleId));
    check(
      "ballot_source.(a) official_candidate_references",
      canonicalize(bs.officialCandidateReferences as unknown as Json),
      canonicalize(entry.candidateReferences as unknown as Json),
    );
    check(
      "ballot_source.(a) official_tie_resolution",
      canonicalize(bs.officialTieResolution as unknown as Json),
      canonicalize(entry.tieResolution as unknown as Json),
    );
    check("ballot_source.(a) seats", String(doc.seats), String(entry.seats));
  }
  const sides = decisionSides(bs.kind, entry.voteOptions ?? [], bs.officialMaxSelections);

  // (f) the framework bar, derived from the RE-READ set and quorum, never from the document's.
  const framework = frameworkFor(bs.kind, entry.parameterSet.id, entry.quorum);
  const raw = asObject(doc.raw);
  check("ballot_source.(f) eligible_voting_power", asString(raw["eligible_voting_power"]) ?? "absent", (framework?.eligible ?? Dec.ZERO).toString());
  check("ballot_source.(f) min_affirmative_support", doc.minAffirmativeSupport.toString(), (framework?.mas ?? Dec.ZERO).toString());
  check("ballot_source.(f) min_unique_voters", String(doc.minUniqueVoters), String(framework?.minUniqueVoters ?? 0));
  check(
    "ballot_source.(f) framework",
    canonicalize(bs.framework === null ? null : ({ source: bs.framework.source, quorum_pc: bs.framework.quorumPc.toString(), mas_pc: bs.framework.masPc.toString(), min_unique_voters: bs.framework.minUniqueVoters, derivation: bs.framework.derivation, bound: bs.framework.bound.toString() } as unknown as Json)),
    canonicalize(framework === null ? null : ({ source: FRAMEWORK_SOURCE, quorum_pc: framework.quorumPc.toString(), mas_pc: framework.masPc.toString(), min_unique_voters: framework.minUniqueVoters, derivation: ELIGIBLE_DERIVATION, bound: framework.bound.toString() } as unknown as Json)),
  );

  // (a) the ballots themselves — the register's `voters` KVS, latest per account, at
  // `ballot_state_version`.
  const ballots = await readOfficialBallots(gw, entry.votersKvsAddress, bs.kind, bs.ballotStateVersion);
  check("ballot_source.(a) ballot_count", String(bs.ballotCount), String(ballots.length));

  const onChain = new Map(ballots.map((b) => [b.account, sortedSelection(b.selection)]));
  const published = new Map(doc.votes.map((v) => [v.account, sortedSelection(v.selection)]));
  const allAccounts = new Set([...onChain.keys(), ...published.keys()]);
  for (const account of [...allAccounts].sort()) {
    const onC = onChain.get(account);
    const pub = published.get(account);
    check(
      `ballot_source.(a) ballots[${account}].selection`,
      pub === undefined ? "absent" : `[${pub.join(",")}]`,
      onC === undefined ? "absent" : `[${onC.join(",")}]`,
    );
  }

  // (b) the official rule: the app's own policy, over the document's own ballots (which (a) has
  // just checked equal the on-chain ones) — every one of them. The official vote has no
  // excluded_accounts bar, so a barred account's ballot counts on this leg; only the OTER leg
  // strikes it.
  //
  // The list comes from THIS package's data/, chosen by the component's network — never from the
  // document, which would make the claim unfalsifiable. The version and hash are checked first,
  // because a mismatch there is the explanation for every total that follows: a document weighed
  // under a list this verifier does not carry is not wrong, it is unverifiable here, and saying
  // so by name is more use than a wall of totals differences.
  const allowlist = officialAllowlistFor(bs.component);
  check("ballot_source.(b) official_rule.rule", bs.officialRule.rule, OFFICIAL_RULE_TEXT);
  check("ballot_source.(b) official_rule.allowlist_version", bs.officialRule.allowlistVersion, allowlist.version);
  check("ballot_source.(b) official_rule.allowlist_hash", bs.officialRule.allowlistHash, allowlist.hash);

  const barred = new Set(doc.excludedAccounts);
  const accounts = [...new Set(doc.votes.map((v) => v.account))];
  const officialBreakdown = await computeAccountWeightBreakdown(
    gw,
    accounts,
    doc.snapshotStateVersion,
    allowlist.sources,
    xrdResource,
  );
  const officialWeights = new Map(
    accounts.map((a) => [a, officialBreakdown.get(a)?.total ?? Dec.ZERO]),
  );
  if (isMjKind(bs.kind)) {
    const optionCount = doc.totals.length;
    const mjBallots: Ballot[] = doc.votes.map((vote, i) => ({
      account: vote.account,
      weight: officialWeights.get(vote.account) ?? Dec.ZERO,
      selection: vote.selection.filter((x) => x >= 0 && x < optionCount),
      ballotIndex: i,
    }));
    const floor = entry.minimumGradeIndex ?? doc.minimumQualifyingGrade;
    const official = officialMjFigures(
      mjBallots,
      optionCount,
      entry.seats ?? doc.seats,
      bs.officialQuorum,
      framework?.minUniqueVoters ?? 0,
      // The official rule settles at the platform's published Grade Quantile; the document's own
      // fraction belongs to the OTER leg.
      THREE_FIFTHS,
      floor,
    );
    for (let i = 0; i < Math.max(official.totals.length, bs.officialRule.totals.length); i++) {
      check(
        `ballot_source.(b) official_rule.totals[${i}]`,
        decStr(bs.officialRule.totals[i]),
        decStr(official.totals[i]),
      );
    }
    check("ballot_source.(b) official_rule.total_weight", bs.officialRule.totalWeight.toString(), official.totalWeight.toString());
    check("ballot_source.(b) official_rule.quorum_met", String(bs.officialRule.quorumMet), String(official.quorumMet));
    check("ballot_source.(b) official_rule.approved", String(bs.officialRule.approved), "null");
    check(
      "ballot_source.(b) official_rule.winners",
      canonicalize(bs.officialRule.winners as unknown as Json),
      canonicalize(official.winners as unknown as Json),
    );
    check(
      "ballot_source.(b) official_rule.majority_judgment",
      canonicalize(bs.officialRule.majorityJudgment),
      canonicalize(official.majorityJudgment),
    );
    // A Majority Judgment round publishes no approval-rule split and no per-source delta.
    check(
      "ballot_source.(b) official_rule.totals_by_source",
      canonicalize(bs.officialRule.totalsBySource as unknown as Json),
      "null",
    );
    check(
      "ballot_source.(e) weight_delta_by_source",
      canonicalize(bs.weightDeltaBySource as unknown as Json),
      "null",
    );
  } else {
    const publishedBallots = new Map(doc.votes.map((v) => [v.account, v.selection]));
    // The official threshold is a fraction (0.5); the bar compares against a percentage.
    const official = officialRuleFigures(
      publishedBallots,
      officialWeights,
      doc.totals.length,
      bs.officialQuorum,
      bs.officialApprovalThreshold.mul(Dec.fromInt(100)),
      framework === null ? null : sides,
      framework?.mas ?? Dec.ZERO,
      framework?.minUniqueVoters ?? 0,
    );
    for (let i = 0; i < Math.max(official.totals.length, bs.officialRule.totals.length); i++) {
      check(
        `ballot_source.(b) official_rule.totals[${i}]`,
        decStr(bs.officialRule.totals[i]),
        decStr(official.totals[i]),
      );
    }
    check("ballot_source.(b) official_rule.total_weight", bs.officialRule.totalWeight.toString(), official.totalWeight.toString());
    check("ballot_source.(b) official_rule.quorum_met", String(bs.officialRule.quorumMet), String(official.quorumMet));
    check("ballot_source.(b) official_rule.approved", String(bs.officialRule.approved), String(official.approved));

    // The official leg's own split. Summed over every account that cast a ballot — the official
    // rule has no bar of its own (their vote has none) and no delegation, so its by-source total
    // is over voters, exactly as the engine's `totals_by_source` is.
    const officialSum = sumLegs(officialBreakdown, accounts, () => true);
    const split = bs.officialRule.totalsBySource;
    if (split === null) {
      check("ballot_source.(b) official_rule.totals_by_source", "null", "an object");
    } else {
      check("ballot_source.(b) official_rule.totals_by_source.liquid", split.liquid.toString(), officialSum.xrd.toString());
      check("ballot_source.(b) official_rule.totals_by_source.lsu", split.lsu.toString(), officialSum.lsu.toString());
      check("ballot_source.(b) official_rule.totals_by_source.lsulp", split.lsulp.toString(), officialSum.lsulp.toString());
      check("ballot_source.(b) official_rule.totals_by_source.pool_units", split.poolUnits.toString(), officialSum.poolUnits.toString());
      check(
        "ballot_source.(b) official_rule.totals_by_source.precision_pools",
        split.precisionPools.toString(),
        officialSum.precisionPools.toString(),
      );
      check("ballot_source.(b) official_rule.totals_by_source.shape_pools", split.shapePools.toString(), officialSum.shapePools.toString());
    }
  }

  // (d) ballots outside the window: both bounds resolved from the official timestamps via the
  // SAME Gateway timestamp selector the engine's own state-version lookup uses — see
  // `resolveStateVersionAtTimestamp` and `ballotsOutsideWindow` above. The lower bound is the
  // state version at the vote's own `start` (`official_start`, which (a) has just checked
  // against the entry) — not `official_snapshot`, which fixes the weights and may precede the
  // window — and is always resolved; the upper bound is unbounded while `official_deadline` has
  // not yet passed.
  const lowerBoundSv = await resolveStateVersionAtTimestamp(gw, xrdResource, bs.officialStart);

  // (a) the weight snapshot's anchor: `snapshot_state_version` must be the state version at the
  // RE-READ snapshot Instant (a Proposal's `start`), through the same selector. When the snapshot
  // is the start, the lookup above already answered it.
  const snapshotInstant = entry.snapshot ?? entry.start;
  const snapshotSv =
    snapshotInstant === bs.officialStart
      ? lowerBoundSv
      : await resolveStateVersionAtTimestamp(gw, xrdResource, snapshotInstant);
  check("ballot_source.(a) snapshot_state_version", String(doc.snapshotStateVersion), String(snapshotSv));

  const nowSeconds = Math.floor(Date.now() / 1000);
  const upperBoundSv =
    bs.officialDeadline > nowSeconds
      ? Number.MAX_SAFE_INTEGER // the engine's own unbounded sentinel: the window is still open
      : await resolveStateVersionAtTimestamp(gw, xrdResource, bs.officialDeadline);
  const outsideWindow = ballotsOutsideWindow(ballots, lowerBoundSv, upperBoundSv);
  check("ballot_source.(d) ballots_outside_window", String(bs.ballotsOutsideWindow), String(outsideWindow));

  // (e) weight_delta_by_source: OTER-rule weight minus official-rule weight, per source, over the
  // participating (non-barred, voting) accounts. Both sides come from the same breakdown struct
  // over the same account set, so an account neither rule weighed contributes nothing rather than
  // appearing as a difference, and a barred ballot is absent from both. A Majority Judgment
  // round publishes no such delta (its official result is a seating, not an approval split), and
  // the check above has already required the document's claim to be null.
  if (!isMjKind(bs.kind)) {
    const breakdown = await computeAccountWeightBreakdown(
      gw,
      accounts,
      doc.snapshotStateVersion,
      oterSources,
      xrdResource,
    );
    const counted = (account: string): boolean => !barred.has(account);
    const oterSum = sumLegs(breakdown, accounts, counted);
    const officialCountedSum = sumLegs(officialBreakdown, accounts, counted);
    const delta = {
      lsu: oterSum.lsu.sub_(officialCountedSum.lsu),
      poolUnits: oterSum.poolUnits.sub_(officialCountedSum.poolUnits),
      lsulp: oterSum.lsulp.sub_(officialCountedSum.lsulp),
      precisionPools: oterSum.precisionPools.sub_(officialCountedSum.precisionPools),
      shapePools: oterSum.shapePools.sub_(officialCountedSum.shapePools),
    };
    const claimed = bs.weightDeltaBySource;
    if (claimed === null) {
      check("ballot_source.(e) weight_delta_by_source", "null", "an object");
    } else {
      check("ballot_source.(e) weight_delta_by_source.lsu", claimed.lsu.toString(), delta.lsu.toString());
      check("ballot_source.(e) weight_delta_by_source.pool_units", claimed.poolUnits.toString(), delta.poolUnits.toString());
      check("ballot_source.(e) weight_delta_by_source.lsulp", claimed.lsulp.toString(), delta.lsulp.toString());
      check(
        "ballot_source.(e) weight_delta_by_source.precision_pools",
        claimed.precisionPools.toString(),
        delta.precisionPools.toString(),
      );
      check("ballot_source.(e) weight_delta_by_source.shape_pools", claimed.shapePools.toString(), delta.shapePools.toString());
    }
  }

  return { differences: diffs, sides };
}
