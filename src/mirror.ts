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
 * optional Abstain options wherever they sit, and a Proposal with any other label set, or a
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
 *       → the entry named by `official_id` → its `voters` KVS, at `ballot_state_version`. This
 *       re-read is compared against `doc.votes` account by account, and the entry's own
 *       metadata against what `ballot_source` claims: the `quorum` / `approval_threshold` of its
 *       parameter-set leg, the set's `{id, label, version, variant}`, `start` / `deadline` /
 *       `vote_count` / `revote_count`, a Temperature Check's `snapshot`, recorded `outcome` and
 *       `continuation`, and a Proposal's `max_selections`. The entry is read in the Governance
 *       1.0.0 shape, by field name; a shape it does not describe is refused, naming the path.
 *   (b) **the official rule** — the app's own policy, recomputed with the SAME weight engine the
 *       OTER rule uses but handed the ALLOWLIST as its register (`src/allowlist.ts`), summed per
 *       option over the same ballots, gated by the same absolute `official_quorum` /
 *       `official_approval_threshold` `ballot_source` carries, and compared against
 *       `ballot_source.official_rule` — its totals, its `totals_by_source` split, and the
 *       `allowlist_version` / `allowlist_hash` naming the list it claims to have applied. The
 *       list comes from this package's own `data/` copy, never from the document: a document
 *       verified against a list it supplied itself would be verified against nothing.
 *   (d) **`ballots_outside_window`** — how many re-read ballots landed outside the window this
 *       document was pinned to. Both bounds are resolved from `official_snapshot` / `official_deadline`
 *       via the SAME Gateway timestamp selector the reference engine's own state-version lookup
 *       uses, ported here rather than approximated — see `resolveStateVersionAtTimestamp` and
 *       `ballotsOutsideWindow` below, whose open-window convention (an unbounded upper bound
 *       while `official_deadline` is still in the future) mirrors the engine's exactly.
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
 *
 * Every mismatch here is reported through the same `Difference` shape `src/verify.ts` already
 * uses for the ordinary (c) figures, tagged `ballot_source.(a|b|d|e|f) …` so the letter that failed
 * is legible in the output without a second Outcome kind.
 */

import type { BallotSource, MirrorKind, TallyDocument } from "./document.ts";
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
import { bindingApproved } from "./verdict.ts";
import { computeAccountWeightBreakdown } from "./weights.ts";
import type { WeightBreakdown } from "./weights.ts";
import type { Difference } from "./verify.ts";

/** Keys per `/state/key-value-store/data` request; pages per `/state/key-value-store/keys` walk. */
const KVS_DATA_CHUNK = 100;
const MAX_KVS_PAGES = 500;

/** `ballot_source.kind` -> the component's own field name for that register. */
function kvsFieldFor(kind: MirrorKind): string {
  return kind === "temperature_check" ? "temperature_checks" : "proposals";
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

/** One official Temperature Check / Proposal entry, re-read at `ballot_state_version`. */
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

/** One ballot, re-read from the `voters` key-value store at `ballot_state_version`. */
export interface OfficialBallot {
  account: string;
  selection: number[];
  lastUpdatedAtStateVersion: number | null;
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
    };
  }

  const maxInner = optionInner(value, "max_selections", field);
  return {
    ...common,
    snapshot: null,
    outcome: null,
    continuation: null,
    maxSelections: maxInner === null ? null : scalarInt(maxInner, `${field} max_selections`),
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
 * The official leg takes the same bar as the OTER leg: the official vote's own absolute quorum
 * and approval threshold, plus the framework's Minimum Affirmative Support and distinct-voter
 * floor for its parameter set. Every counted ballot enters `total_weight` (and so quorum),
 * Abstain included; only the Approve and Reject sides enter the decisive share. `approved` is
 * `null` when the vote has no decision sides — a label set other than Approve/Reject(/Abstain),
 * a multi-select proposal, or a parameter set the framework table does not name.
 */
function officialRuleFigures(
  ballots: Map<string, number[]>,
  weights: Map<string, Dec>,
  barred: Set<string>,
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
    if (barred.has(account)) continue;
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
 * Both bounds are themselves resolved from `official_snapshot` / `official_deadline` by
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
 * Every mirror-specific check (a), (b), (d), (e), (f) — everything `ballot_source` adds on top of the
 * ordinary v20 pipeline that `src/verify.ts` already runs unchanged for (c). `[]` on an ordinary
 * document (`doc.isMirror` false); the caller is expected to skip calling this in that case, but
 * it is harmless either way.
 */
export async function verifyMirrorBallots(
  doc: TallyDocument,
  gw: GatewayClient,
  xrdResource: string,
): Promise<Difference[]> {
  const bs: BallotSource | null = doc.ballotSource;
  if (bs === null) return [];
  const diffs: Difference[] = [];
  const check = (field: string, document: string, recomputed: string): void => {
    if (document !== recomputed) diffs.push({ field, document, recomputed });
  };

  // (a) component state -> the register -> the entry -> its own published parameters.
  const entry = await readOfficialEntry(gw, bs.component, bs.kind, bs.officialId, bs.ballotStateVersion);
  check("ballot_source.(a) blueprint", bs.blueprint, entry.blueprint);
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

  // (a) the ballots themselves — the register's `voters` KVS, latest per account.
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
  // just checked equal the on-chain ones) and its own excluded_accounts bar.
  //
  // The list comes from THIS package's data/, chosen by the component's network — never from the
  // document, which would make the claim unfalsifiable. The version and hash are checked first,
  // because a mismatch there is the explanation for every total that follows: a document weighed
  // under a list this verifier does not carry is not wrong, it is unverifiable here, and saying
  // so by name is more use than a wall of totals differences.
  const allowlist = officialAllowlistFor(bs.component);
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
  const publishedBallots = new Map(doc.votes.map((v) => [v.account, v.selection]));
  // The official threshold is a fraction (0.5); the bar compares against a percentage.
  const official = officialRuleFigures(
    publishedBallots,
    officialWeights,
    barred,
    doc.totals.length,
    bs.officialQuorum,
    bs.officialApprovalThreshold.mul(Dec.fromInt(100)),
    framework === null ? null : decisionSides(bs.kind, doc.options, bs.officialMaxSelections),
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
  // rule has no bar of its own (their vote has none) and no delegation, so its by-source total is
  // over voters, exactly as the engine's `totals_by_source` is.
  const officialSum = sumLegs(officialBreakdown, accounts, () => true);
  check("ballot_source.(b) official_rule.totals_by_source.liquid", bs.officialRule.totalsBySource.liquid.toString(), officialSum.xrd.toString());
  check("ballot_source.(b) official_rule.totals_by_source.lsu", bs.officialRule.totalsBySource.lsu.toString(), officialSum.lsu.toString());
  check("ballot_source.(b) official_rule.totals_by_source.lsulp", bs.officialRule.totalsBySource.lsulp.toString(), officialSum.lsulp.toString());
  check("ballot_source.(b) official_rule.totals_by_source.pool_units", bs.officialRule.totalsBySource.poolUnits.toString(), officialSum.poolUnits.toString());
  check(
    "ballot_source.(b) official_rule.totals_by_source.precision_pools",
    bs.officialRule.totalsBySource.precisionPools.toString(),
    officialSum.precisionPools.toString(),
  );
  check("ballot_source.(b) official_rule.totals_by_source.shape_pools", bs.officialRule.totalsBySource.shapePools.toString(), officialSum.shapePools.toString());

  // (d) ballots outside the window: both bounds resolved from the official timestamps via the
  // SAME Gateway timestamp selector the engine's own state-version lookup uses — see
  // `resolveStateVersionAtTimestamp` and `ballotsOutsideWindow` above. The lower bound is the
  // snapshot's state version (`official_snapshot`, which (a) has just checked against the
  // entry) and is always resolved; the upper bound is unbounded while `official_deadline` has
  // not yet passed.
  const lowerBoundSv = await resolveStateVersionAtTimestamp(gw, xrdResource, bs.officialSnapshot);
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
  // appearing as a difference, and a barred ballot is absent from both.
  const breakdown = await computeAccountWeightBreakdown(
    gw,
    accounts,
    doc.snapshotStateVersion,
    doc.weightSources,
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
  check("ballot_source.(e) weight_delta_by_source.lsu", bs.weightDeltaBySource.lsu.toString(), delta.lsu.toString());
  check("ballot_source.(e) weight_delta_by_source.pool_units", bs.weightDeltaBySource.poolUnits.toString(), delta.poolUnits.toString());
  check("ballot_source.(e) weight_delta_by_source.lsulp", bs.weightDeltaBySource.lsulp.toString(), delta.lsulp.toString());
  check(
    "ballot_source.(e) weight_delta_by_source.precision_pools",
    bs.weightDeltaBySource.precisionPools.toString(),
    delta.precisionPools.toString(),
  );
  check("ballot_source.(e) weight_delta_by_source.shape_pools", bs.weightDeltaBySource.shapePools.toString(), delta.shapePools.toString());

  return diffs;
}
