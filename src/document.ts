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

import { Dec } from "./decimal.ts";
import type { Json } from "./canonical.ts";
import { asArray, asObject, asString } from "./gateway.ts";
import { GRADES } from "./verdict.ts";
import type { WeightSources } from "./weights.ts";

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
  /** The weight the document CLAIMS this account had. The recomputation replaces it. */
  weight: Dec;
}

export interface TallyDocument {
  /** The document exactly as given, for re-serialization and re-hashing. */
  raw: Json;
  consultationId: string;
  kind: string;
  snapshotStateVersion: number;
  weightSources: WeightSources;
  votes: TallyVote[];
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
  winners: number[] | null;
  withdrawnExcluded: number[] | null;
  approveWeight: Dec | null;
  rejectWeight: Dec | null;
  approved: boolean | null;
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
  switch (mode) {
    case "off":
      return { native_pools: { mode: "off" } };
    case "all":
      return { native_pools: { mode: "all" } };
    case "allowlist": {
      const pools = asArray(np["pools"]).map((p) => {
        const s = asString(p);
        if (s === null) fail("weight_sources.native_pools.pools", "contains a non-string");
        return s;
      });
      return { native_pools: { mode: "allowlist", pools } };
    }
    default:
      // A typo'd mode is an error, not a fallback to the default: a tally silently verified
      // under the wrong register weighs the wrong electorate.
      return fail("weight_sources.native_pools.mode", `has unknown mode ${JSON.stringify(mode)}`);
  }
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
    return { account: account as string, selection, weight };
  });

  const snapshotStateVersion = reqInt(raw, "snapshot_state_version");
  if (snapshotStateVersion <= 0) fail("snapshot_state_version", "is not a positive state version");

  const winnersRaw = raw["winners"];
  const winners = winnersRaw === null || winnersRaw === undefined
    ? null
    : (optIntArray(winnersRaw, "winners") as number[]);

  const doc: TallyDocument = {
    raw: raw as Json,
    consultationId: reqString(raw, "consultation_id"),
    kind,
    snapshotStateVersion,
    weightSources: parseWeightSources(raw["weight_sources"]),
    votes,
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
    winners,
    withdrawnExcluded: optIntArray(raw["withdrawn_excluded"], "withdrawn_excluded"),
    approveWeight: optDec(raw, "approve_weight"),
    rejectWeight: optDec(raw, "reject_weight"),
    approved: optBool(raw, "approved"),
  };
  return { doc, envelopeHash };
}
