/**
 * Mirror-tally verification (`plan-w1-mirror-tallies.md` §1, §3, §6): the extra checks a
 * document carrying `ballot_source` gets on top of the ordinary v20 pipeline.
 *
 * A mirror document publishes TWO tallies of the SAME on-chain ballots — the official Radix DAO
 * Consultation App's own rule (liquid XRD only) and this platform's `WEIGHT_RULE` — so that the
 * only thing the two can disagree about is the weight function. Both use the official vote's own
 * absolute `quorum` and `approval_threshold`. The top-level document fields (`votes`, `totals`,
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
 *       `quorum` / `approval_threshold` / `start` / `deadline` / `vote_count` / `revote_count`
 *       are compared against what `ballot_source` claims they are.
 *   (b) **the official rule** — liquid XRD only, no LSU/pool/lsulp/concentrated-liquidity
 *       conversion — summed per option over the same ballots, gated by the same absolute
 *       `official_quorum` / `official_approval_threshold` `ballot_source` carries, compared
 *       against `ballot_source.official_rule`.
 *   (d) **`ballots_outside_window`** — how many re-read ballots landed outside the window this
 *       document was pinned to. Both bounds are resolved from `official_start` / `official_deadline`
 *       via the SAME Gateway timestamp selector the reference engine's `state_version_at`
 *       (`backend/src/tally_engine.rs`) uses, ported here rather than approximated — see
 *       `resolveStateVersionAtTimestamp` and `count_outside_window`'s Rust counterpart in
 *       `backend/src/official_tally.rs`, whose open-window convention (`deadline_state_version =
 *       i64::MAX` while `official_deadline` is still in the future) this mirrors exactly.
 *   (e) **`weight_delta_by_source`** — the per-leg gap between the OTER-rule total and the
 *       official-rule total: what LSUs, native pool units, LSULP, the two concentrated-liquidity
 *       legs, and delegation each added on top of a plain balance read.
 *
 * Every mismatch here is reported through the same `Difference` shape `src/verify.ts` already
 * uses for the ordinary (c) figures, tagged `ballot_source.(a|b|d|e) …` so the letter that failed
 * is legible in the output without a second Outcome kind.
 */

import type { BallotSource, MirrorKind, TallyDocument } from "./document.ts";
import { Dec } from "./decimal.ts";
import { delegatedWeightByDelegate, resolveDelegations } from "./delegation.ts";
import { GatewayError, asArray, asObject, asString } from "./gateway.ts";
import type { GatewayClient } from "./gateway.ts";
import { stateField } from "./concentrated.ts";
import { WeightRuleError } from "./concentrated.ts";
import { bindingApproved } from "./verdict.ts";
import { computeAccountWeightBreakdown, fetchFungiblesAt } from "./weights.ts";
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
  quorum: Dec;
  approvalThreshold: Dec;
  start: number;
  deadline: number;
  voteCount: number;
  revoteCount: number;
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
 * matches — the register carries only a handful of entries in practice (7 Temperature Checks, 3
 * Proposals, per `plan-w1-mirror-tallies.md` §6), so a full page walk is cheap, and it means the
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

  return {
    blueprint,
    votersKvsAddress,
    quorum: tupleFieldDec(value, "quorum", field),
    approvalThreshold: tupleFieldDec(value, "approval_threshold", field),
    start: tupleFieldInt(value, "start", field),
    deadline: tupleFieldInt(value, "deadline", field),
    voteCount: tupleFieldInt(value, "vote_count", field),
    revoteCount: tupleFieldInt(value, "revote_count", field),
  };
}

/**
 * Decode one ballot's `programmatic_json` value into a selection over Poll option order
 * `["Against", "For"]` (Temperature Check) or raw option indices (Proposal).
 *
 * Temperature Check: `TemperatureCheckVoterEntry { vote: Enum TemperatureCheckVote }`, `For` is
 * variant 0 and `Against` is variant 1 (`plan-w1-mirror-tallies.md` §6) — the OPPOSITE of the
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

/**
 * The official rule, recomputed: liquid XRD only (no LSU, no pool, no lsulp, no
 * concentrated-liquidity), summed per Poll option, gated by `ballot_source`'s own absolute
 * `official_quorum` / `official_approval_threshold`. Assumes a binary Approve/Reject bar — every
 * mirror document this tool has seen publishes one, matching the official component's own
 * Temperature-Check and binary-Proposal shape (`plan-w1-mirror-tallies.md` §6) — and refuses
 * (MALFORMED) rather than guess at a multi-select official bar the plan does not specify.
 */
function officialRuleFigures(
  ballots: Map<string, number[]>,
  liquidXrd: Map<string, Dec>,
  barred: Set<string>,
  optionCount: number,
  quorum: Dec,
  approvalThresholdPc: Dec,
): { totals: Dec[]; totalWeight: Dec; quorumMet: boolean; approved: boolean } {
  if (optionCount !== 2) {
    throw new WeightRuleError(
      `the official rule is only defined here for a binary Approve/Reject bar; this document's ` +
        `option space has width ${optionCount}`,
    );
  }
  const totals = [Dec.ZERO, Dec.ZERO];
  let totalWeight = Dec.ZERO;
  for (const [account, selection] of ballots) {
    if (barred.has(account)) continue;
    const weight = liquidXrd.get(account) ?? Dec.ZERO;
    totalWeight = totalWeight.add(weight);
    for (const idx of selection) {
      if (idx === 0 || idx === 1) totals[idx] = (totals[idx] as Dec).add(weight);
    }
  }
  const quorumMet = totalWeight.gte(quorum);
  const approved = bindingApproved(
    totals[1] as Dec,
    totals[0] as Dec,
    approvalThresholdPc,
    Dec.ZERO, // the official rule carries no MAS floor
    quorumMet,
    true, // mirror documents are always tally_doc_version 20+: inclusive comparison
  );
  return { totals, totalWeight, quorumMet, approved };
}

/**
 * Unix seconds -> ISO 8601. The engine's `state_version_at` builds its timestamp with
 * `chrono::DateTime::to_rfc3339()`, which spells the UTC offset `+00:00`; `Date.toISOString()`
 * spells it `Z`. Both are the same instant in the same standard, and the Gateway's timestamp
 * selector parses either — this is a spelling difference, not a semantic one.
 */
function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The last ledger state at or before `unixSeconds`, via the Gateway's timestamp selector.
 *
 * This is the SAME call the reference engine's `state_version_at` makes
 * (`backend/src/tally_engine.rs` ~:3380), ported rather than approximated: XRD is used as the
 * anchor address exactly as the engine uses `XRD_RESOURCE_ADDRESS`, since any well-known entity
 * works and the entity's own data is never read — only the response envelope's
 * `ledger_state.state_version` is wanted.
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
 * STATE-VERSION terms — ported from the reference engine's `count_outside_window`
 * (`backend/src/official_tally.rs`), not approximated:
 *
 * "Compared as STATE VERSIONS rather than timestamps, because the gateway offers a
 * timestamp -> state-version selector and no cheap inverse: resolving one timestamp per ballot
 * would be one round trip per voter, where the two window bounds are two round trips for the
 * whole vote. The comparison is exact either way — state version is monotone in ledger time."
 *
 * Both bounds are themselves resolved from `official_start` / `official_deadline` by
 * {@link resolveStateVersionAtTimestamp} — the caller's job, not this pure function's, exactly as
 * the engine separates `count_outside_window` (the comparison) from the two `state_version_at`
 * calls that produce its bounds. `upperBoundSv` is `Number.MAX_SAFE_INTEGER` while the deadline is
 * still in the future (the engine's `deadline_state_version = i64::MAX`): there is no ledger state
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
 * Every mirror-specific check (a), (b), (d), (e) — everything `ballot_source` adds on top of the
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

  // (b) the official rule: liquid XRD only, over the document's own ballots (which (a) has just
  // checked equal the on-chain ones) and its own excluded_accounts bar.
  const barred = new Set(doc.excludedAccounts);
  const accounts = [...new Set(doc.votes.map((v) => v.account))];
  const fungibles = await fetchFungiblesAt(gw, accounts, doc.snapshotStateVersion);
  const liquidXrd = new Map(accounts.map((a) => [a, fungibles.get(a)?.get(xrdResource) ?? Dec.ZERO]));
  const publishedBallots = new Map(doc.votes.map((v) => [v.account, v.selection]));
  const official = officialRuleFigures(
    publishedBallots,
    liquidXrd,
    barred,
    doc.totals.length,
    bs.officialQuorum,
    bs.officialApprovalThreshold,
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

  // (d) ballots outside the window: both bounds resolved from the official timestamps via the
  // SAME Gateway timestamp selector the engine's `state_version_at` uses — see
  // `resolveStateVersionAtTimestamp` and `ballotsOutsideWindow` above. `vote_start_state_version`
  // is always resolved (a ballot's window cannot open in the future); `deadline_state_version` is
  // unbounded while `official_deadline` has not yet passed.
  const lowerBoundSv = await resolveStateVersionAtTimestamp(gw, xrdResource, bs.officialStart);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const upperBoundSv =
    bs.officialDeadline > nowSeconds
      ? Number.MAX_SAFE_INTEGER // the engine's i64::MAX: the window is still open
      : await resolveStateVersionAtTimestamp(gw, xrdResource, bs.officialDeadline);
  const outsideWindow = ballotsOutsideWindow(ballots, lowerBoundSv, upperBoundSv);
  check("ballot_source.(d) ballots_outside_window", String(bs.ballotsOutsideWindow), String(outsideWindow));

  // (e) weight_delta_by_source: the per-leg gap between the OTER-rule total and the official-rule
  // total, over the same participating (non-barred, voting) accounts, plus delegation's net.
  const delegationAccounts = [
    ...new Set([...accounts, ...(doc.delegationInput ?? []).map((d) => d.delegator)]),
  ];
  const breakdown = await computeAccountWeightBreakdown(
    gw,
    delegationAccounts,
    doc.snapshotStateVersion,
    doc.weightSources,
    xrdResource,
  );
  let lsu = Dec.ZERO;
  let poolUnits = Dec.ZERO;
  let lsulp = Dec.ZERO;
  let precisionPools = Dec.ZERO;
  let shapePools = Dec.ZERO;
  for (const account of accounts) {
    if (barred.has(account)) continue;
    const b = breakdown.get(account);
    if (b === undefined) continue;
    lsu = lsu.add(b.lsu);
    poolUnits = poolUnits.add(b.poolUnits);
    lsulp = lsulp.add(b.lsulp);
    precisionPools = precisionPools.add(b.precisionPools);
    shapePools = shapePools.add(b.shapePools);
  }
  let delegationNet = Dec.ZERO;
  if (doc.delegationInput !== null) {
    const voted = new Set(doc.votes.map((v) => v.account));
    const resolved = resolveDelegations(doc.delegationInput, voted, barred);
    const weights = new Map(delegationAccounts.map((a) => [a, breakdown.get(a)?.total ?? Dec.ZERO]));
    delegationNet = delegatedWeightByDelegate(resolved, weights).total;
  }
  check("ballot_source.(e) weight_delta_by_source.lsu", bs.weightDeltaBySource.lsu.toString(), lsu.toString());
  check("ballot_source.(e) weight_delta_by_source.pool_units", bs.weightDeltaBySource.poolUnits.toString(), poolUnits.toString());
  check("ballot_source.(e) weight_delta_by_source.lsulp", bs.weightDeltaBySource.lsulp.toString(), lsulp.toString());
  check(
    "ballot_source.(e) weight_delta_by_source.precision_pools",
    bs.weightDeltaBySource.precisionPools.toString(),
    precisionPools.toString(),
  );
  check("ballot_source.(e) weight_delta_by_source.shape_pools", bs.weightDeltaBySource.shapePools.toString(), shapePools.toString());
  check(
    "ballot_source.(e) weight_delta_by_source.delegation_net",
    bs.weightDeltaBySource.delegationNet.toString(),
    delegationNet.toString(),
  );

  return diffs;
}
