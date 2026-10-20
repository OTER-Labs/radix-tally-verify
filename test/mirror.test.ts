/**
 * Mirror mode (`ballot_source` present, `src/mirror.ts`) driven end to end through
 * `verifyTallyDocument`: the official component's own state (a Temperature Check, three
 * ballots — a liquid-only voter, a staked voter, and a revoter) is re-read from a fake Gateway,
 * the official rule and the OTER rule are both recomputed, and each is compared against what
 * `ballot_source` and the top-level document claim.
 *
 * One MATCH, then one broken figure per check (a)-(e), each asserting the outcome is FIGURES
 * with a difference tagged to the check that actually failed — the same discipline
 * `legs-end-to-end.test.ts` applies to the concentrated-liquidity legs.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { ELIGIBLE_DERIVATION, FRAMEWORK_SOURCE } from "../src/framework.ts";
import { OFFICIAL_RULE_TEXT } from "../src/mirror.ts";
import { verifyTallyDocument } from "../src/verify.ts";

import { FakeGateway, SNAPSHOT_SV, XRD } from "./fake-gateway.ts";

const hash = (doc: Record<string, unknown>): string => tallyHash(doc as unknown as Json);

// A STOKENET governance component: `officialAllowlistFor` picks the shipped list by the
// address's own bech32 prefix, and the stokenet list names no DEX position (none of the three
// DEXes deploys there), so the official rule here is direct XRD plus every validator's
// LSUs — Tier 1, and exactly what a test stack can produce. The mainnet list's own content and
// hash are checked directly in `allowlist.test.ts` rather than driven through a fake Gateway
// that would have to serve sixty-nine pools.
const COMPONENT = "component_tdx_2_1cp0governance000000000000000000000000000000000007";
/** blake2b-256 of the canonical `[]` — the stokenet list's `allowlist_hash`. */
const STOKENET_ALLOWLIST_HASH = "c2c013c86a9c92e22f966f3d8617768f8b7a44c902adcc097bfa1e098afb4e1f";
const TC_REGISTER_KVS = "internal_keyvaluestore_rdx1kvtc0000000000000000000000000000000008";
const VOTERS_KVS = "internal_keyvaluestore_rdx1kvvoters00000000000000000000000000009";
const LSU = "resource_rdx1lsu000000000000000000000000000000000000000000000001";
const VALIDATOR = "validator_rdx1vvv";

const ACC_LIQUID = "account_rdx1liquid0000000000000000000000000000000000000000001";
const ACC_STAKED = "account_rdx1staked0000000000000000000000000000000000000000002";
const ACC_REVOTER = "account_rdx1revoter000000000000000000000000000000000000000003";

const OFFICIAL_START = 1754000000;
const OFFICIAL_DEADLINE = 1754604800;
const BALLOT_SV = SNAPSHOT_SV + 50;
/** The state version the official entry was last written at, and read at: after the last ballot,
 * as a Temperature Check's is once its outcome is recorded. */
const ENTRY_SV = BALLOT_SV + 25;

/** A mirror tally document over the fixture Temperature Check: liquid-only For, staked For,
 * Against revoter.
 *
 * The two rules AGREE here, and that is the case worth pinning: validator LSUs are Tier 1 in
 * both, the stokenet allowlist names no pool, and nobody holds one — so both legs read Against
 * 30, For 145 (120 liquid + the staked voter's 25 XRD of LSU), total 175, and every
 * `weight_delta_by_source` leg is zero. A staked voter weighing the same under both rules is the
 * whole point of the rule as it now stands: an earlier version of this fixture's official leg
 * dropped the 25. Both use the
 * official absolute quorum 100 / threshold 0.5 (published as 50 %), and the framework's
 * Temperature Check bar: 3 % of a derived eligible voting power of 3333.333… (100 * 100 / 3), no
 * MAS, no voter floor. */
function mirrorDoc(over: Record<string, unknown> = {}, ballotSourceOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tally_doc_version: 20,
    consultation_id: "official:temperature_check:5",
    kind: "Poll", // the engine routes a mirror as a Poll; the binary verdict fields come from ballot_source.kind
    options: ["Against", "For"],
    snapshot_state_version: SNAPSHOT_SV,
    excluded_accounts: [],
    weight_sources: { native_pools: { mode: "all" } },
    votes: [
      { account: ACC_LIQUID, selection: [1], weight: "100" },
      { account: ACC_STAKED, selection: [1], weight: "45" },
      { account: ACC_REVOTER, selection: [0], weight: "30" },
    ],
    totals: ["30", "145"],
    total_weight: "175",
    abstain_weight: "0",
    voter_count: 3,
    quorum: "100",
    approval_threshold_pc: "50",
    min_affirmative_support: "0",
    min_unique_voters: 0,
    quorum_met: true,
    mas_met: true,
    seats: 0,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
    withdrawn_excluded: null,
    approve_weight: "145",
    reject_weight: "30",
    approved: true,
    eligible_voting_power: "3333.333333333333333333",
    ballot_source: {
      mirror_doc_version: 3,
      component: COMPONENT,
      blueprint: "Governance",
      kind: "temperature_check",
      official_id: 5,
      official_start: OFFICIAL_START,
      official_deadline: OFFICIAL_DEADLINE,
      official_quorum: "100",
      official_approval_threshold: "0.5",
      official_vote_count: 4,
      official_revote_count: 1,
      ballot_count: 3,
      ballot_state_version: BALLOT_SV,
      official_entry_state_version: ENTRY_SV,
      ballots_outside_window: 0,
      official_rule: {
        rule: OFFICIAL_RULE_TEXT,
        allowlist_version: "2026-09-06",
        allowlist_hash: STOKENET_ALLOWLIST_HASH,
        totals: ["30", "145"],
        totals_by_source: {
          liquid: "150",
          lsu: "25",
          lsulp: "0",
          pool_units: "0",
          precision_pools: "0",
          shape_pools: "0",
        },
        total_weight: "175",
        quorum_met: true,
        approved: true,
      },
      weight_delta_by_source: {
        lsu: "0",
        pool_units: "0",
        lsulp: "0",
        precision_pools: "0",
        shape_pools: "0",
      },
      official_snapshot: OFFICIAL_START,
      official_parameter_set: { id: "default", label: "Standard Executable", version: 1, variant: "Standard" },
      official_outcome: null,
      official_continuation: null,
      official_max_selections: null,
      framework: {
        source: FRAMEWORK_SOURCE,
        quorum_pc: "3",
        mas_pc: "0",
        min_unique_voters: 0,
        eligible_voting_power_derivation: ELIGIBLE_DERIVATION,
        eligible_voting_power_bound: "33.333333333333333333",
      },
      // A stokenet component weighed on a stokenet stack: the register applies whole.
      oter_register_scope: "full",
      ...ballotSourceOver,
    },
    ...over,
  };
}

/** account -> liquid XRD (+ LSU for the staked voter), all single-page. Reused for every
 * fetchFungiblesAt call the mirror path and the ordinary pipeline each make over the same three
 * accounts — the response only needs to be built once. */
function accountsFungibles(): unknown {
  return {
    items: [
      { address: ACC_LIQUID, fungible_resources: { items: [{ resource_address: XRD, amount: "100" }] } },
      {
        address: ACC_STAKED,
        fungible_resources: {
          items: [
            { resource_address: XRD, amount: "20" },
            { resource_address: LSU, amount: "50" },
          ],
        },
      },
      { address: ACC_REVOTER, fungible_resources: { items: [{ resource_address: XRD, amount: "30" }] } },
    ],
  };
}

function resourceInfo(): unknown {
  return { items: [{ address: LSU, details: { total_supply: "2000" }, explicit_metadata: { items: [] } }] };
}

function validatorsResponse(): unknown {
  return {
    validators: {
      next_cursor: null,
      items: [
        {
          address: VALIDATOR,
          stake_vault: { balance: "1000" },
          state: { stake_unit_resource_address: LSU },
        },
      ],
    },
  };
}

function componentDetails(): unknown {
  return {
    items: [
      {
        address: COMPONENT,
        details: {
          blueprint_name: "Governance",
          state: { fields: [{ field_name: "temperature_checks", value: TC_REGISTER_KVS }] },
        },
      },
    ],
  };
}

function tcRegisterKeys(): unknown {
  return { items: [{ key: { programmatic_json: { value: "5" } } }], next_cursor: null };
}

/** The Temperature Check entry in the Governance 1.0.0 shape: quorum and threshold on the
 * `temperature_check` leg of its own `Standard` parameter-set snapshot, plus its own `snapshot`,
 * and no outcome or continuation recorded yet. */
function tcRegisterData(
  over: {
    setId?: string;
    quorum?: string;
    threshold?: string;
    deadline?: string;
    snapshot?: string;
    /** A recorded outcome: `Passed` / `Failed` at `recordedAt`. */
    outcome?: { result: "Passed" | "Failed"; recordedAt: number };
    /** A recorded continuation into official Proposal `proposalId`. */
    continuationProposalId?: number;
  } = {},
): unknown {
  const s = (field_name: string, value: string) => ({ field_name, value });
  const fields = [
    s("voters", VOTERS_KVS),
    {
      field_name: "parameter_set",
      kind: "Tuple",
      fields: [
        s("id", over.setId ?? "default"),
        s("label", "Standard Executable"),
        s("version", "1"),
        {
          field_name: "parameters",
          kind: "Enum",
          variant_name: "Standard",
          fields: [
            { field_name: "temperature_check", kind: "Tuple", fields: [s("voting_days", "5"), s("quorum", over.quorum ?? "100"), s("approval_threshold", over.threshold ?? "0.5")] },
            { field_name: "proposal", kind: "Tuple", fields: [s("voting_days", "7"), s("quorum", "1000"), s("approval_threshold", "0.5")] },
          ],
        },
      ],
    },
    s("snapshot", over.snapshot ?? String(OFFICIAL_START)),
    s("start", String(OFFICIAL_START)),
    s("deadline", over.deadline ?? String(OFFICIAL_DEADLINE)),
    s("vote_count", "4"),
    s("revote_count", "1"),
    over.outcome === undefined
      ? { field_name: "outcome", kind: "Enum", variant_name: "None", fields: [] }
      : {
          field_name: "outcome",
          kind: "Enum",
          variant_name: "Some",
          fields: [{ kind: "Enum", variant_name: over.outcome.result, fields: [s("recorded_at", String(over.outcome.recordedAt))] }],
        },
    over.continuationProposalId === undefined
      ? { field_name: "continuation", kind: "Enum", variant_name: "None", fields: [] }
      : {
          field_name: "continuation",
          kind: "Enum",
          variant_name: "Some",
          fields: [{ kind: "Enum", variant_name: "Proposal", fields: [{ kind: "U64", value: String(over.continuationProposalId) }] }],
        },
  ];
  return { entries: [{ value: { programmatic_json: { fields } } }] };
}

function votersKeys(): unknown {
  return {
    next_cursor: null,
    items: [ACC_LIQUID, ACC_STAKED, ACC_REVOTER].map((a) => ({
      key: { programmatic_json: { value: a } },
    })),
  };
}

/** One voter entry: `vote` is the TemperatureCheckVote enum (`For` -> Poll index 1, `Against`
 * -> Poll index 0 — the mapping inverts, see `src/mirror.ts`'s `decodeSelection`). */
function voterEntry(account: string, vote: "For" | "Against", lastUpdatedAtStateVersion: number) {
  return {
    key: { programmatic_json: { value: account } },
    value: {
      programmatic_json: {
        fields: [
          { field_name: "vote_id", value: "1" },
          { field_name: "vote", variant_name: vote, fields: [] },
        ],
      },
    },
    last_updated_at_state_version: lastUpdatedAtStateVersion,
  };
}

function votersData(entriesOver?: unknown[]): unknown {
  return {
    entries: entriesOver ?? [
      voterEntry(ACC_LIQUID, "For", SNAPSHOT_SV + 10),
      voterEntry(ACC_STAKED, "For", SNAPSHOT_SV + 30),
      voterEntry(ACC_REVOTER, "Against", BALLOT_SV),
    ],
  };
}

/** The Gateway's timestamp -> state-version resolver response (`entityDetailsAtTimestamp`,
 * `resolveStateVersionAtTimestamp` in `src/mirror.ts`) — only `ledger_state.state_version` is
 * read off it. */
function timestampDetails(stateVersion: number): unknown {
  return { ledger_state: { state_version: stateVersion } };
}

/** The whole scenario, wired in the exact call order `src/mirror.ts` and the ordinary pipeline
 * make them: component -> register -> voters (check a), the official-rule weight walk under the
 * shipped allowlist (check b — a full breakdown now, not a balance read), the window
 * bounds (check d: `official_start` resolves to `startSv`, `official_deadline` to `deadlineSv` —
 * `null` means the window is still open, so no deadline call happens at all), the
 * weight-breakdown read (check e), then the ordinary OTER-rule pipeline re-reads the same
 * balances again for check (c). `overrides` replace one queued response to break exactly one
 * check without disturbing the rest. */
function mirrorGateway(overrides: {
  componentDetails?: unknown;
  tcRegisterData?: unknown;
  /** The Temperature Check entry as the ledger held it from each state version on — answered by
   * the version a read asks for. Replaces `tcRegisterData` when given. */
  tcRegisterDataAt?: Array<[number, unknown]>;
  votersData?: unknown;
  startSv?: number;
  deadlineSv?: number | null;
  /** Unix seconds -> state version, answered by instant rather than in call order. When given,
   * `startSv` / `deadlineSv` are not queued. */
  timestampSv?: Record<number, number>;
  /** The LSULP pair's details, read by the OTER-rule walks (e) and (c) when the register they
   * apply names a pair. The official leg's stokenet allowlist names none. */
  lsulpDetails?: unknown;
} = {}): FakeGateway {
  const gw = new FakeGateway()
    .onDetails(overrides.componentDetails ?? componentDetails())
    .onDetails(accountsFungibles()) // (b) official-rule breakdown, under the ALLOWLIST register
    .onDetails(resourceInfo()) // (b) its held-resource info
    .onDetails(accountsFungibles()); // (e) OTER-rule breakdown fungibles
  if (overrides.lsulpDetails !== undefined) gw.onDetails(overrides.lsulpDetails); // (e) the LSULP rate
  gw.onDetails(resourceInfo()) // (e) weight-breakdown held-resource info
    .onDetails(accountsFungibles()); // (c) the ordinary OTER-rule pipeline
  if (overrides.lsulpDetails !== undefined) gw.onDetails(overrides.lsulpDetails); // (c) the LSULP rate
  gw.onDetails(resourceInfo()) // (c) the ordinary OTER-rule pipeline
    .onValidators(validatorsResponse())
    .onValidators(validatorsResponse())
    .onValidators(validatorsResponse());
  if (overrides.timestampSv !== undefined) {
    for (const [seconds, sv] of Object.entries(overrides.timestampSv)) {
      gw.onTimestampDetailsAt(Number(seconds), timestampDetails(sv));
    }
  } else {
    gw.onTimestampDetails(timestampDetails(overrides.startSv ?? SNAPSHOT_SV)); // (d) official_start
    const deadlineSv = "deadlineSv" in overrides ? overrides.deadlineSv : BALLOT_SV;
    if (deadlineSv !== null) {
      gw.onTimestampDetails(timestampDetails(deadlineSv)); // (d) official_deadline, window closed
    }
  }
  gw.onKvsKeys(TC_REGISTER_KVS, tcRegisterKeys());
  if (overrides.tcRegisterDataAt !== undefined) {
    for (const [sv, data] of overrides.tcRegisterDataAt) gw.onKvsDataAt(TC_REGISTER_KVS, sv, data);
  } else {
    gw.onKvsData(TC_REGISTER_KVS, overrides.tcRegisterData ?? tcRegisterData());
  }
  return gw
    .onKvsKeys(VOTERS_KVS, votersKeys())
    .onKvsData(VOTERS_KVS, overrides.votersData ?? votersData());
}

test("ballot_source presence makes a document a mirror, and a plain document is not one", async () => {
  const { parseTallyDocument } = await import("../src/document.ts");
  const { doc } = parseTallyDocument(mirrorDoc());
  assert.equal(doc.isMirror, true);
  assert.ok(doc.ballotSource !== null);
  assert.equal(doc.ballotSource?.officialId, 5);

  const { doc: plain } = parseTallyDocument({
    tally_doc_version: 20,
    consultation_id: "c-1",
    kind: "Binding",
    snapshot_state_version: SNAPSHOT_SV,
    votes: [],
    totals: ["0", "0"],
    total_weight: "0",
    abstain_weight: "0",
    voter_count: 0,
    quorum: "0",
    approval_threshold_pc: "50",
    min_affirmative_support: "0",
    min_unique_voters: 0,
    quorum_met: true,
    seats: 0,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
  });
  assert.equal(plain.isMirror, false);
  assert.equal(plain.ballotSource, null);
});

test("a correct mirror document is a MATCH", async () => {
  const doc = mirrorDoc();
  const outcome = await verifyTallyDocument(doc, hash(doc), mirrorGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

/**
 * v22: a mirror document carries the four new keys as the SPACE-0 CONSTANTS — the reference
 * engine writes them on every document unconditionally, mirror or not, and a
 * mirror consultation lives in the Radix/XRD space like every consultation did before spaces
 * existed. `src/mirror.ts` is otherwise unaffected (every test above and below this one is
 * unchanged): the four keys are additive fields the mirror path never reads, exactly like every
 * other v20 field it does not touch.
 */
test("a mirror document carries the v22 space keys as the space-0 constants, and still MATCHes", async () => {
  const doc = mirrorDoc({
    tally_doc_version: 22,
    space_id: 0,
    weight_config: { kind: "Xrd" },
    term_seconds: 0,
    asset_symbol: "XRD",
  });
  const { parseTallyDocument } = await import("../src/document.ts");
  const { doc: parsed } = parseTallyDocument(doc);
  assert.equal(parsed.spaceId, 0);
  assert.deepEqual(parsed.weightConfig, { kind: "Xrd" });
  assert.equal(parsed.termSeconds, 0);
  assert.equal(parsed.assetSymbol, "XRD");
  assert.equal(parsed.isMirror, true);

  const outcome = await verifyTallyDocument(doc, hash(doc), mirrorGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("(a) a ballot the chain does not agree with is a figures disagreement naming (a)", async () => {
  const doc = mirrorDoc();
  const outcome = await verifyTallyDocument(
    doc,
    null,
    mirrorGateway({
      // The chain now says the revoter voted For, not Against — doc.votes still claims Against.
      votersData: votersData([
        voterEntry(ACC_LIQUID, "For", SNAPSHOT_SV + 10),
        voterEntry(ACC_STAKED, "For", SNAPSHOT_SV + 30),
        voterEntry(ACC_REVOTER, "For", BALLOT_SV),
      ]),
    }),
    XRD,
  );
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const d = outcome.differences.find((x) => /ballot_source\.\(a\) ballots\[.*revoter.*\]\.selection/.test(x.field));
  assert.ok(d, `expected an (a) ballots[...] difference, got: ${JSON.stringify(outcome.differences)}`);
});

/** The old number: an official leg that read liquid XRD only put 120 on the For side and
 * dropped the staked voter's 25. It is now a DIFFERENCE, which is the regression this check
 * exists to catch — a mirror still claiming the old rule's figure is claiming a rule the
 * Consultation App does not apply. */
test("(b) a wrong official-rule total is a figures disagreement naming (b)", async () => {
  const doc = mirrorDoc(
    {},
    {
      official_rule: {
        rule: OFFICIAL_RULE_TEXT,
        allowlist_version: "2026-09-06",
        allowlist_hash: STOKENET_ALLOWLIST_HASH,
        totals: ["30", "120"],
        totals_by_source: {
          liquid: "150",
          lsu: "25",
          lsulp: "0",
          pool_units: "0",
          precision_pools: "0",
          shape_pools: "0",
        },
        total_weight: "150",
        quorum_met: true,
        approved: true,
      },
    },
  );
  const outcome = await verifyTallyDocument(doc, null, mirrorGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const d = outcome.differences.find((x) => x.field === "ballot_source.(b) official_rule.totals[1]");
  assert.ok(d, `expected an (b) official_rule.totals[1] difference, got: ${JSON.stringify(outcome.differences)}`);
  assert.equal(d?.document, "120");
  assert.equal(d?.recomputed, "145");
});

/** The allowlist itself is checked before any total: a document weighed under a list this
 * verifier does not carry is unverifiable here, and the hash is what says so by name. The list
 * comes from `data/`, never from the document — otherwise the field would be a claim checked
 * against itself. */
test("(b) an allowlist hash the verifier does not carry is a figures disagreement naming (b)", async () => {
  const doc = mirrorDoc(
    {},
    {
      official_rule: {
        rule: OFFICIAL_RULE_TEXT,
        allowlist_version: "2099-01-01",
        allowlist_hash: "00".repeat(32),
        totals: ["30", "145"],
        totals_by_source: {
          liquid: "150",
          lsu: "25",
          lsulp: "0",
          pool_units: "0",
          precision_pools: "0",
          shape_pools: "0",
        },
        total_weight: "175",
        quorum_met: true,
        approved: true,
      },
    },
  );
  const outcome = await verifyTallyDocument(doc, null, mirrorGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const version = outcome.differences.find(
    (x) => x.field === "ballot_source.(b) official_rule.allowlist_version",
  );
  const digest = outcome.differences.find(
    (x) => x.field === "ballot_source.(b) official_rule.allowlist_hash",
  );
  assert.ok(version, `expected an allowlist_version difference: ${JSON.stringify(outcome.differences)}`);
  assert.equal(version?.recomputed, "2026-09-06");
  assert.ok(digest, `expected an allowlist_hash difference: ${JSON.stringify(outcome.differences)}`);
  assert.equal(digest?.recomputed, STOKENET_ALLOWLIST_HASH);
});

test("(f) a wrong eligible_voting_power is a figures disagreement naming (f)", async () => {
  const doc = mirrorDoc({ eligible_voting_power: "3333" });
  const out = await verifyTallyDocument(doc, hash(doc), mirrorGateway(), XRD);
  assert.equal(out.kind, "figures");
  assert.ok(out.kind === "figures" && out.differences.some((d) => d.field.startsWith("ballot_source.(f)")));
});

test("(a) a parameter set the chain does not carry is a figures disagreement naming (a)", async () => {
  const doc = mirrorDoc({}, { official_parameter_set: { id: "dao-governance", label: "Standard Executable", version: 1, variant: "Standard" } });
  const out = await verifyTallyDocument(doc, hash(doc), mirrorGateway(), XRD);
  assert.equal(out.kind, "figures");
  assert.ok(out.kind === "figures" && out.differences.some((d) => d.field === "ballot_source.(a) official_parameter_set"));
});

test("a mirror_doc_version 2 block is refused rather than checked under v3", async () => {
  const doc = mirrorDoc({}, { mirror_doc_version: 2 });
  const out = await verifyTallyDocument(doc, hash(doc), mirrorGateway(), XRD);
  assert.equal(out.kind, "malformed");
});

test("a Majority Judgment mirror is refused as not implemented", async () => {
  const doc = mirrorDoc({}, { kind: "majority_judgment_election" });
  const out = await verifyTallyDocument(doc, hash(doc), mirrorGateway(), XRD);
  assert.equal(out.kind, "malformed");
  assert.ok(out.kind === "malformed" && out.reason.includes("Majority Judgment"));
});

/** A version-1 block states the official rule as liquid XRD only. It is refused at PARSE time
 * rather than recomputed under version 2's rule, which would compare a number against a rule
 * that did not produce it. */
test("a mirror_doc_version 1 block is refused rather than checked under the new rule", async () => {
  const { parseTallyDocument, DocumentError } = await import("../src/document.ts");
  const doc = mirrorDoc({}, { mirror_doc_version: 1 });
  assert.throws(
    () => parseTallyDocument(doc),
    (e: unknown) => e instanceof DocumentError && /mirror_doc_version/.test((e as Error).message),
  );
});

test("(c) a wrong published OTER-rule weight is a figures disagreement, the ordinary (c) path unchanged", async () => {
  const doc = mirrorDoc();
  (doc["votes"] as Array<Record<string, Json>>)[1] = { account: ACC_STAKED, selection: [1], weight: "44" };
  const outcome = await verifyTallyDocument(doc, null, mirrorGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const d = outcome.differences.find((x) => x.field.includes("votes[1].weight"));
  assert.ok(d, `expected the ordinary votes[1].weight difference, got: ${JSON.stringify(outcome.differences)}`);
  assert.equal(d?.document, "44");
  assert.equal(d?.recomputed, "45");
});

test("(d) a ballot after the resolved deadline is counted as late", async () => {
  // official_deadline resolves to SNAPSHOT_SV + 40 — between the staked voter's ballot (SV
  // SNAPSHOT_SV + 30, still inside) and the revoter's (BALLOT_SV = SNAPSHOT_SV + 50, now
  // outside). The document still claims 0: this is exactly the case the OLD
  // `[snapshot_state_version, ballot_state_version]` bound could never catch, because
  // `ballot_state_version` is BY DEFINITION the max ballot SV seen — nothing can ever exceed it.
  const doc = mirrorDoc({}, { ballots_outside_window: 0 });
  const outcome = await verifyTallyDocument(
    doc,
    null,
    mirrorGateway({ deadlineSv: SNAPSHOT_SV + 40 }),
    XRD,
  );
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const d = outcome.differences.find((x) => x.field === "ballot_source.(d) ballots_outside_window");
  assert.ok(d, `expected a (d) ballots_outside_window difference, got: ${JSON.stringify(outcome.differences)}`);
  assert.equal(d?.document, "0");
  assert.equal(d?.recomputed, "1");
});

test("(d) a still-open window (deadline in the future) counts no ballot late", async () => {
  // official_deadline set far in the future: the upper bound is unbounded (the engine's
  // unbounded `deadline_state_version`), so no `entityDetailsAtTimestamp` call is even made for
  // it — `mirrorGateway({ deadlineSv: null })` queues none, and an unexpected call fails loudly.
  const futureDeadline = Math.floor(Date.now() / 1000) + 10_000_000;
  const doc = mirrorDoc({}, { official_deadline: futureDeadline, ballots_outside_window: 0 });
  const outcome = await verifyTallyDocument(
    doc,
    hash(doc),
    mirrorGateway({
      deadlineSv: null,
      // The on-chain entry's own `deadline` must agree with the document's — otherwise this
      // would (correctly) fail check (a) instead of exercising the open-window path check (d) is
      // actually about.
      tcRegisterData: tcRegisterData({ deadline: String(futureDeadline) }),
    }),
    XRD,
  );
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

/**
 * A vote whose weight snapshot precedes its own start, as a Majority Judgment rerun's does (it
 * weighs at round one's snapshot and opens at its own start). The window opens at `start`: the
 * liquid voter's ballot, cast after the snapshot but before the start, is outside it. The
 * timestamps are answered by instant, so a lower bound resolved from `official_snapshot` gets the
 * snapshot's state version and counts that ballot inside.
 */
test("(d) the window opens at the vote's own start, not at an earlier weight snapshot", async () => {
  const snapshot = OFFICIAL_START - 86_400;
  const timestampSv = {
    [snapshot]: SNAPSHOT_SV, // before every ballot
    [OFFICIAL_START]: SNAPSHOT_SV + 20, // after the liquid voter's (+10), before the rest
    [OFFICIAL_DEADLINE]: BALLOT_SV,
  };
  const doc = mirrorDoc({}, { official_snapshot: snapshot, ballots_outside_window: 1 });
  const outcome = await verifyTallyDocument(
    doc,
    hash(doc),
    mirrorGateway({ tcRegisterData: tcRegisterData({ snapshot: String(snapshot) }), timestampSv }),
    XRD,
  );
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });

  // A document that opened the window at the snapshot instead, counting no ballot late, is a (d)
  // disagreement and nothing else.
  const early = mirrorDoc({}, { official_snapshot: snapshot, ballots_outside_window: 0 });
  const outcomeEarly = await verifyTallyDocument(
    early,
    null,
    mirrorGateway({ tcRegisterData: tcRegisterData({ snapshot: String(snapshot) }), timestampSv }),
    XRD,
  );
  assert.equal(outcomeEarly.kind, "figures");
  if (outcomeEarly.kind !== "figures") return;
  assert.deepEqual(outcomeEarly.differences, [
    { field: "ballot_source.(d) ballots_outside_window", document: "0", recomputed: "1" },
  ]);
});

// ---------------------------------------------------------------------------------------------
// The entry is re-read at official_entry_state_version, the ballots at ballot_state_version. A
// Temperature Check records its outcome, and any continuation, after its deadline — so after its
// last ballot. Here the ledger holds the entry without either from the last ballot (BALLOT_SV) on,
// and with both from ENTRY_SV on; the fake gateway answers the entry by the version asked for.

const OUTCOME_RECORDED_AT = OFFICIAL_DEADLINE + 3_600;

function settledEntryAt(): Array<[number, unknown]> {
  return [
    [BALLOT_SV, tcRegisterData()],
    [ENTRY_SV, tcRegisterData({ outcome: { result: "Passed", recordedAt: OUTCOME_RECORDED_AT }, continuationProposalId: 6 })],
  ];
}

function settledMirrorDoc(entryStateVersion: number): Record<string, unknown> {
  return mirrorDoc(
    {},
    {
      official_entry_state_version: entryStateVersion,
      official_outcome: { result: "Passed", recorded_at: OUTCOME_RECORDED_AT },
      official_continuation: { kind: "proposal", id: 6 },
    },
  );
}

test("(a) a settled Temperature Check's outcome is read at official_entry_state_version, and is a MATCH", async () => {
  const doc = settledMirrorDoc(ENTRY_SV);
  const gw = mirrorGateway({ tcRegisterDataAt: settledEntryAt() });
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
  // The entry at the entry's version, the voters at the ballots'.
  assert.ok(gw.calls.includes(`kvs-data:${TC_REGISTER_KVS}@${ENTRY_SV}`), gw.calls.join("\n"));
  assert.ok(gw.calls.includes(`kvs-data:${VOTERS_KVS}@${BALLOT_SV}`), gw.calls.join("\n"));
});

test("(a) the same document naming an entry version before the outcome differs on the outcome", async () => {
  const doc = settledMirrorDoc(BALLOT_SV);
  const outcome = await verifyTallyDocument(doc, null, mirrorGateway({ tcRegisterDataAt: settledEntryAt() }), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  assert.deepEqual(outcome.differences, [
    {
      field: "ballot_source.(a) official_outcome",
      document: `{"recordedAt":${OUTCOME_RECORDED_AT},"result":"Passed"}`,
      recomputed: "null",
    },
    { field: "ballot_source.(a) official_continuation", document: '{"id":6,"kind":"proposal"}', recomputed: "null" },
  ]);
});

test("(a) an official_entry_state_version before the entry existed is refused by name", async () => {
  const doc = settledMirrorDoc(SNAPSHOT_SV);
  const outcome = await verifyTallyDocument(doc, null, mirrorGateway({ tcRegisterDataAt: settledEntryAt() }), XRD);
  assert.equal(outcome.kind, "malformed", JSON.stringify(outcome));
  assert.ok(
    outcome.kind === "malformed" && outcome.reason.includes(`entry 5 of ${COMPONENT} has no value at sv ${SNAPSHOT_SV}`),
    JSON.stringify(outcome),
  );
});

test("a v3 document without an integer official_entry_state_version is MALFORMED naming the key", async () => {
  for (const value of [undefined, null, "559737684", 1.5]) {
    const doc = mirrorDoc();
    const bs = doc["ballot_source"] as Record<string, unknown>;
    if (value === undefined) delete bs["official_entry_state_version"];
    else bs["official_entry_state_version"] = value;
    const out = await verifyTallyDocument(doc, null, mirrorGateway(), XRD);
    assert.equal(out.kind, "malformed", JSON.stringify(value));
    assert.ok(
      out.kind === "malformed" && out.reason.includes("ballot_source.official_entry_state_version"),
      JSON.stringify(out),
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The weight snapshot's anchor: snapshot_state_version is the state version at the entry's own
// snapshot Instant (a Proposal's start), resolved by the same timestamp selector as (d).

test("(a) a snapshot_state_version that is not the state version at official_snapshot differs by name", async () => {
  // start == snapshot here, and the selector resolves that instant to SNAPSHOT_SV - 7, not the
  // SNAPSHOT_SV the document was weighed at. No ballot moves across the window bound.
  const doc = mirrorDoc();
  const outcome = await verifyTallyDocument(doc, null, mirrorGateway({ startSv: SNAPSHOT_SV - 7 }), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  assert.deepEqual(outcome.differences, [
    { field: "ballot_source.(a) snapshot_state_version", document: String(SNAPSHOT_SV), recomputed: String(SNAPSHOT_SV - 7) },
  ]);
});

test("(a) a Temperature Check weighed at its start instead of its own snapshot differs on snapshot_state_version", async () => {
  const snapshot = OFFICIAL_START - 86_400;
  const timestampSv = {
    [snapshot]: SNAPSHOT_SV,
    [OFFICIAL_START]: SNAPSHOT_SV + 5, // before every ballot, so (d) is unaffected
    [OFFICIAL_DEADLINE]: BALLOT_SV,
  };
  const doc = mirrorDoc({ snapshot_state_version: SNAPSHOT_SV + 5 }, { official_snapshot: snapshot });
  const outcome = await verifyTallyDocument(
    doc,
    null,
    mirrorGateway({ tcRegisterData: tcRegisterData({ snapshot: String(snapshot) }), timestampSv }),
    XRD,
  );
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  assert.deepEqual(outcome.differences, [
    { field: "ballot_source.(a) snapshot_state_version", document: String(SNAPSHOT_SV + 5), recomputed: String(SNAPSHOT_SV) },
  ]);
});

test("(e) a stale weight_delta_by_source leg is a figures disagreement naming (e)", async () => {
  const doc = mirrorDoc(
    {},
    {
      weight_delta_by_source: {
        lsu: "25",
        pool_units: "0",
        lsulp: "0",
        precision_pools: "0",
        shape_pools: "0",
      },
    },
  );
  const outcome = await verifyTallyDocument(doc, null, mirrorGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const d = outcome.differences.find((x) => x.field === "ballot_source.(e) weight_delta_by_source.lsu");
  assert.ok(d, `expected a (e) weight_delta_by_source.lsu difference, got: ${JSON.stringify(outcome.differences)}`);
  // The old claim: "the LSU leg is what the official rule drops". Both rules count it now,
  // so the honest delta is zero and a document still claiming 25 is claiming a rule nobody applies.
  assert.equal(d?.document, "25");
  assert.equal(d?.recomputed, "0");
});

/**
 * The DAO-controlled-funds bar is the OTER rule's, not the official vote's. Here the revoter
 * (Against, 30) is in `excluded_accounts` and the official quorum is 150:
 *
 * - the OTER leg strikes the ballot: Against 0, For 145, `total_weight` 145, two voters — and
 *   145 misses the 150 quorum, so nothing is approved;
 * - the official leg counts it, as the official vote does: Against 30, For 145, `total_weight`
 *   175 — quorum met, approved.
 *
 * So the barred ballot moves the official leg's totals, its weight and (through them) its
 * quorum verdict, and a document publishing exactly that is a MATCH. `totals_by_source` stays
 * over every voter, and `weight_delta_by_source` over the OTER leg's counted accounts, as ever.
 */
function barredMirrorDoc(): Record<string, unknown> {
  return mirrorDoc(
    {
      excluded_accounts: [ACC_REVOTER],
      votes: [
        { account: ACC_LIQUID, selection: [1], weight: "100" },
        { account: ACC_STAKED, selection: [1], weight: "45" },
        { account: ACC_REVOTER, selection: [0], weight: "30", excluded: true },
      ],
      totals: ["0", "145"],
      total_weight: "145",
      voter_count: 2,
      quorum: "150",
      quorum_met: false,
      approve_weight: "145",
      reject_weight: "0",
      approved: false,
      eligible_voting_power: "5000",
    },
    {
      official_quorum: "150",
      official_rule: {
        rule: OFFICIAL_RULE_TEXT,
        allowlist_version: "2026-09-06",
        allowlist_hash: STOKENET_ALLOWLIST_HASH,
        totals: ["30", "145"],
        totals_by_source: {
          liquid: "150",
          lsu: "25",
          lsulp: "0",
          pool_units: "0",
          precision_pools: "0",
          shape_pools: "0",
        },
        total_weight: "175",
        quorum_met: true,
        approved: true,
      },
    },
  );
}

test("a barred account's ballot counts on the official leg and not on the OTER leg, and is a MATCH", async () => {
  const doc = barredMirrorDoc();
  const outcome = await verifyTallyDocument(
    doc,
    hash(doc),
    mirrorGateway({ tcRegisterData: tcRegisterData({ quorum: "150" }) }),
    XRD,
  );
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("a mirror that bars the official leg too is a figures disagreement naming (b)", async () => {
  // The same vote, published as if the official leg had struck the barred ballot: Against 0,
  // total_weight 145, quorum missed. The official vote has no such bar, so every one of those
  // is wrong — and the OTER leg, which does strike it, is untouched and raises nothing.
  const doc = barredMirrorDoc();
  const bs = doc["ballot_source"] as Record<string, unknown>;
  bs["official_rule"] = {
    ...(bs["official_rule"] as Record<string, unknown>),
    totals: ["0", "145"],
    total_weight: "145",
    quorum_met: false,
    approved: false,
  };
  const outcome = await verifyTallyDocument(
    doc,
    null,
    mirrorGateway({ tcRegisterData: tcRegisterData({ quorum: "150" }) }),
    XRD,
  );
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const byField = new Map(outcome.differences.map((x) => [x.field, x]));
  assert.deepEqual(
    [...byField.keys()].sort(),
    [
      "ballot_source.(b) official_rule.approved",
      "ballot_source.(b) official_rule.quorum_met",
      "ballot_source.(b) official_rule.total_weight",
      "ballot_source.(b) official_rule.totals[0]",
    ],
    "only the official leg's figures differ; the OTER leg's bar is intact",
  );
  assert.equal(byField.get("ballot_source.(b) official_rule.totals[0]")?.recomputed, "30");
  assert.equal(byField.get("ballot_source.(b) official_rule.total_weight")?.recomputed, "175");
  assert.equal(byField.get("ballot_source.(b) official_rule.quorum_met")?.recomputed, "true");
});

test("the OTER leg still strikes the barred ballot: counting it there is a figures disagreement", async () => {
  // The top-level (OTER-rule) figures published as if the bar did not exist: the recomputation
  // strikes the barred ballot, so Against is 0, not 30, and the voter count 2, not 3.
  const doc = barredMirrorDoc();
  doc["totals"] = ["30", "145"];
  doc["total_weight"] = "175";
  doc["voter_count"] = 3;
  const outcome = await verifyTallyDocument(
    doc,
    null,
    mirrorGateway({ tcRegisterData: tcRegisterData({ quorum: "150" }) }),
    XRD,
  );
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const totals0 = outcome.differences.find((x) => x.field === "totals[0]");
  const voters = outcome.differences.find((x) => x.field === "voter_count");
  assert.ok(totals0, `expected a totals[0] difference, got: ${JSON.stringify(outcome.differences)}`);
  assert.equal(totals0?.recomputed, "0");
  assert.equal(voters?.recomputed, "2");
  assert.ok(
    !outcome.differences.some((x) => x.field.startsWith("ballot_source.(b)")),
    "the official leg, which counts the ballot, agrees",
  );
});

// --- An official Proposal: three options decided by label, Abstain counted toward quorum only. ---

const GP_REGISTER_KVS = "internal_keyvaluestore_rdx1kvgp0000000000000000000000000000000010";
const GP_OPTIONS = ["Reject", "Abstain", "Approve"];

/** `vote_options` as the Gateway renders it: `ProposalVoteOption { id: ProposalVoteOptionId(U32),
 * label }` tuples. `order` lists the ids in array order (default: id order). */
function voteOptionsField(labels: string[], order: number[] = labels.map((_, i) => i)): unknown {
  return {
    field_name: "vote_options",
    kind: "Array",
    element_kind: "Tuple",
    elements: order.map((id) => ({
      kind: "Tuple",
      type_name: "ProposalVoteOption",
      fields: [
        { field_name: "id", kind: "Tuple", type_name: "ProposalVoteOptionId", fields: [{ kind: "U32", value: String(id) }] },
        { field_name: "label", kind: "String", value: labels[id] },
      ],
    })),
  };
}

/** The Proposal entry in the Governance 1.0.0 shape: its own `Standard` parameter-set snapshot,
 * read on the `proposal` leg; no `snapshot`, `outcome` or `continuation`; `max_selections` None;
 * `vote_options` labelled `GP_OPTIONS` unless `voteOptions` says otherwise. */
function gpRegisterData(setId: string, voteOptions: unknown = voteOptionsField(GP_OPTIONS)): unknown {
  const s = (field_name: string, value: string) => ({ field_name, value });
  const fields = [
    voteOptions,
    { field_name: "max_selections", kind: "Enum", variant_name: "None", fields: [] },
    s("temperature_check_id", "5"),
    s("voters", VOTERS_KVS),
    {
      field_name: "parameter_set",
      kind: "Tuple",
      fields: [
        s("id", setId),
        s("label", "Treasury"),
        s("version", "1"),
        {
          field_name: "parameters",
          kind: "Enum",
          variant_name: "Standard",
          fields: [
            { field_name: "temperature_check", kind: "Tuple", fields: [s("voting_days", "5"), s("quorum", "30"), s("approval_threshold", "0.5")] },
            { field_name: "proposal", kind: "Tuple", fields: [s("voting_days", "7"), s("quorum", "140"), s("approval_threshold", "0.5")] },
          ],
        },
      ],
    },
    s("start", String(OFFICIAL_START)),
    s("deadline", String(OFFICIAL_DEADLINE)),
    s("vote_count", "3"),
    s("revote_count", "0"),
  ];
  return { entries: [{ value: { programmatic_json: { fields } } }] };
}

/** One `ProposalVoterEntry`: `options` is an array of `ProposalVoteOptionId(U32)` tuples. */
function gpVoterEntry(account: string, option: number, lastUpdatedAtStateVersion: number) {
  return {
    key: { programmatic_json: { value: account } },
    value: {
      programmatic_json: {
        fields: [
          { field_name: "vote_id", value: "1" },
          { field_name: "options", kind: "Array", elements: [{ kind: "Tuple", fields: [{ kind: "U32", value: String(option) }] }] },
        ],
      },
    },
    last_updated_at_state_version: lastUpdatedAtStateVersion,
  };
}

function gpGateway(setId: string, voteOptions?: unknown): FakeGateway {
  return new FakeGateway()
    .onDetails({
      items: [
        {
          address: COMPONENT,
          details: {
            blueprint_name: "Governance",
            state: { fields: [{ field_name: "proposals", value: GP_REGISTER_KVS }] },
          },
        },
      ],
    })
    .onDetails(accountsFungibles())
    .onDetails(resourceInfo())
    .onDetails(accountsFungibles())
    .onDetails(resourceInfo())
    .onDetails(accountsFungibles())
    .onDetails(resourceInfo())
    .onValidators(validatorsResponse())
    .onValidators(validatorsResponse())
    .onValidators(validatorsResponse())
    .onTimestampDetails(timestampDetails(SNAPSHOT_SV)) // (d) official_snapshot (= start)
    .onTimestampDetails(timestampDetails(BALLOT_SV)) // (d) official_deadline
    .onKvsKeys(GP_REGISTER_KVS, { items: [{ key: { programmatic_json: { value: "7" } } }], next_cursor: null })
    .onKvsData(GP_REGISTER_KVS, gpRegisterData(setId, voteOptions))
    .onKvsKeys(VOTERS_KVS, votersKeys())
    .onKvsData(VOTERS_KVS, {
      entries: [
        gpVoterEntry(ACC_LIQUID, 2, SNAPSHOT_SV + 10), // Approve, 100
        gpVoterEntry(ACC_STAKED, 1, SNAPSHOT_SV + 30), // Abstain, 45 (20 XRD + 25 XRD of LSU)
        gpVoterEntry(ACC_REVOTER, 0, BALLOT_SV), // Reject, 30
      ],
    });
}

/**
 * A mirror of official Proposal 7, options `["Reject", "Abstain", "Approve"]` — Approve LAST, so
 * a positional reading gets the sides wrong. Approve 100, Abstain 45, Reject 30: the Abstain
 * weight is in `total_weight` (quorum 140 is met only with it) and in `abstain_weight`, and
 * outside the decisive share (100 of 130 approves at 50 %).
 *
 * `default`: 5 % quorum → eligible 140 * 100 / 5 = 2800, MAS 1 % = 28 — met.
 * `dao-treasury`: 7 % quorum → eligible 2000, MAS 1.5 % = 30 — met, but its 50-voter floor is
 * not (three voters), so quorum fails and nothing is approved, on both legs.
 */
function gpDoc(setId: "default" | "dao-treasury"): Record<string, unknown> {
  const treasury = setId === "dao-treasury";
  const framework = treasury
    ? { quorum_pc: "7", mas_pc: "1.5", min_unique_voters: 50, bound: "14.285714285714285714", eligible: "2000", mas: "30" }
    : { quorum_pc: "5", mas_pc: "1", min_unique_voters: 0, bound: "20", eligible: "2800", mas: "28" };
  const quorumMet = !treasury;
  return mirrorDoc(
    {
      consultation_id: "official:proposal:7",
      options: GP_OPTIONS,
      votes: [
        { account: ACC_LIQUID, selection: [2], weight: "100" },
        { account: ACC_STAKED, selection: [1], weight: "45" },
        { account: ACC_REVOTER, selection: [0], weight: "30" },
      ],
      totals: ["30", "45", "100"],
      total_weight: "175",
      abstain_weight: "45",
      quorum: "140",
      min_affirmative_support: framework.mas,
      min_unique_voters: framework.min_unique_voters,
      quorum_met: quorumMet,
      mas_met: true,
      approve_weight: "100",
      reject_weight: "30",
      approved: quorumMet,
      eligible_voting_power: framework.eligible,
    },
    {
      kind: "proposal",
      official_id: 7,
      official_quorum: "140",
      official_vote_count: 3,
      official_revote_count: 0,
      official_rule: {
        rule: OFFICIAL_RULE_TEXT,
        allowlist_version: "2026-09-06",
        allowlist_hash: STOKENET_ALLOWLIST_HASH,
        totals: ["30", "45", "100"],
        totals_by_source: { liquid: "150", lsu: "25", lsulp: "0", pool_units: "0", precision_pools: "0", shape_pools: "0" },
        total_weight: "175",
        quorum_met: quorumMet,
        approved: quorumMet,
      },
      official_snapshot: OFFICIAL_START,
      official_parameter_set: { id: setId, label: "Treasury", version: 1, variant: "Standard" },
      framework: {
        source: FRAMEWORK_SOURCE,
        quorum_pc: framework.quorum_pc,
        mas_pc: framework.mas_pc,
        min_unique_voters: framework.min_unique_voters,
        eligible_voting_power_derivation: ELIGIBLE_DERIVATION,
        eligible_voting_power_bound: framework.bound,
      },
    },
  );
}

test("a three-option proposal decides by label, Abstain toward quorum only, and is a MATCH", async () => {
  const doc = gpDoc("default");
  const out = await verifyTallyDocument(doc, hash(doc), gpGateway("default"), XRD);
  assert.deepEqual(out, { kind: "match", hashChecked: true });
});

test("the dao-treasury voter floor fails quorum on both legs, and is a MATCH", async () => {
  const doc = gpDoc("dao-treasury");
  const out = await verifyTallyDocument(doc, hash(doc), gpGateway("dao-treasury"), XRD);
  assert.deepEqual(out, { kind: "match", hashChecked: true });
});

test("on-chain option labels listed out of id order are read in id order, and the document is a MATCH", async () => {
  // The same labels, the array rendered [Approve (id 2), Reject (id 0), Abstain (id 1)]: the
  // ballots index by id, so the labels are placed by id, not by array position.
  const doc = gpDoc("default");
  const out = await verifyTallyDocument(doc, hash(doc), gpGateway("default", voteOptionsField(GP_OPTIONS, [2, 0, 1])), XRD);
  assert.deepEqual(out, { kind: "match", hashChecked: true });
});

test("a document with Approve and Reject swapped differs on (a) options and is judged by the on-chain labels", async () => {
  // Chain: ["Reject", "Abstain", "Approve"]. The document swaps the two decisive labels and
  // publishes the verdict those swapped labels give — approve 30 (option 0), reject 100 — which
  // is internally consistent, and the ballots still match by index. Deriving the sides from the
  // document's labels would re-derive that same inverted verdict and agree with it.
  const doc = gpDoc("default");
  doc["options"] = ["Approve", "Abstain", "Reject"];
  doc["approve_weight"] = "30";
  doc["reject_weight"] = "100";
  doc["approved"] = false;
  const bs = doc["ballot_source"] as Record<string, unknown>;
  bs["official_rule"] = { ...(bs["official_rule"] as Record<string, unknown>), approved: false };
  const out = await verifyTallyDocument(doc, null, gpGateway("default"), XRD);
  assert.equal(out.kind, "figures");
  if (out.kind !== "figures") return;
  const byField = new Map(out.differences.map((d) => [d.field, d]));
  assert.deepEqual(
    [...byField.keys()].sort(),
    [
      "approve_weight",
      "approved",
      "ballot_source.(a) options",
      "ballot_source.(b) official_rule.approved",
      "reject_weight",
    ],
  );
  assert.deepEqual(byField.get("ballot_source.(a) options"), {
    field: "ballot_source.(a) options",
    document: '["Approve","Abstain","Reject"]',
    recomputed: '["Reject","Abstain","Approve"]',
  });
  assert.equal(byField.get("approve_weight")?.recomputed, "100");
  assert.equal(byField.get("reject_weight")?.recomputed, "30");
  assert.equal(byField.get("approved")?.recomputed, "true");
  assert.equal(byField.get("ballot_source.(b) official_rule.approved")?.recomputed, "true");
});

test("a proposal entry whose vote_options ids are not 0..n-1 is MALFORMED, naming the path", async () => {
  const doc = gpDoc("default");
  const dup = voteOptionsField(GP_OPTIONS, [0, 1, 1]);
  const out = await verifyTallyDocument(doc, null, gpGateway("default", dup), XRD);
  assert.equal(out.kind, "malformed");
  assert.ok(out.kind === "malformed" && out.reason.includes("vote_options[2].id"), JSON.stringify(out));
});

test("a proposal document that decides by position is a figures disagreement", async () => {
  // A positional reading takes option 0 (Reject) as the affirmative side: approve 30, reject 45.
  const doc = gpDoc("default");
  doc["approve_weight"] = "30";
  doc["reject_weight"] = "45";
  doc["approved"] = false;
  const out = await verifyTallyDocument(doc, null, gpGateway("default"), XRD);
  assert.equal(out.kind, "figures");
  const fields = out.kind === "figures" ? out.differences.map((d) => d.field) : [];
  assert.ok(fields.includes("approve_weight") && fields.includes("approved"), JSON.stringify(fields));
});

// ---------------------------------------------------------------------------------------------
// (g) the register scope. The fixture's official component is on stokenet. A registry on
// stokenet makes the scope "full"; a registry on mainnet makes it "network_independent", and
// then no leg that names an address may reach the stokenet gateway.

const STOKENET_LSULP_POOL = "component_tdx_2_1lsulppool0000000000000000000000000000000000001";
const STOKENET_LSULP = "resource_tdx_2_1lsulp0000000000000000000000000000000000000000002";
const STOKENET_DELEGATION = "component_tdx_2_1delegation000000000000000000000000000000000003";
const MAINNET_NATIVE_POOL = "pool_rdx1nativepool00000000000000000000000000000000000000000004";
const MAINNET_LSULP_POOL = "component_rdx1lsulppool000000000000000000000000000000000000005";
const MAINNET_LSULP = "resource_rdx1lsulp00000000000000000000000000000000000000000006";
const MAINNET_PRECISION = "component_rdx1precision00000000000000000000000000000000000007";
const MAINNET_SHAPE = "component_rdx1shape000000000000000000000000000000000000000008";
const MAINNET_DELEGATION = "component_rdx1delegation0000000000000000000000000000000000009";
const MAINNET_REGISTER_ADDRESSES = [
  MAINNET_NATIVE_POOL,
  MAINNET_LSULP_POOL,
  MAINNET_LSULP,
  MAINNET_PRECISION,
  MAINNET_SHAPE,
  MAINNET_DELEGATION,
];

/** The LSULP pair at the snapshot: rate 1. Nobody in the fixture holds LSULP, so naming the pair
 * reads the rate and changes no weight. */
function lsulpDetails(component: string, resource: string): unknown {
  return {
    items: [
      { address: component, details: { state: { fields: [{ field_name: "dex_valuation_xrd", value: "1000" }] } } },
      { address: resource, details: { total_supply: "1000" } },
    ],
  };
}

/** The gateway calls that named any of `addresses`. */
function callsNaming(gw: FakeGateway, addresses: string[]): string[] {
  return gw.calls.filter((c) => addresses.some((a) => c.includes(a)));
}

test("(g) scopedRegister: \"full\" drops delegation only; \"network_independent\" keeps discovery and nothing named", async () => {
  const { scopedRegister } = await import("../src/mirror.ts");
  const named = {
    native_pools: { mode: "allowlist" as const, pools: [MAINNET_NATIVE_POOL] },
    lsulp: { mode: "component" as const, component: MAINNET_LSULP_POOL, resource: MAINNET_LSULP },
    precision_pools: { mode: "allowlist" as const, pools: [MAINNET_PRECISION] },
    shape_pools: { mode: "allowlist" as const, pools: [MAINNET_SHAPE] },
    delegation: { mode: "component" as const, component: MAINNET_DELEGATION },
  };
  const { delegation: _d, ...withoutDelegation } = named;
  assert.deepEqual(scopedRegister(named, "full"), withoutDelegation);
  // An allowlist turns off rather than widening into discovery.
  assert.deepEqual(scopedRegister(named, "network_independent"), { native_pools: { mode: "off" } });
  // Discovery names nothing, so it stays.
  assert.deepEqual(
    scopedRegister({ ...named, native_pools: { mode: "all" } }, "network_independent"),
    { native_pools: { mode: "all" } },
  );
});

test("(g) \"full\": a registry on the component's own network applies its whole register, delegation off, and is a MATCH", async () => {
  const { parsePinnedWeightSet } = await import("../src/document.ts");
  const weightSet = parsePinnedWeightSet({
    network: "stokenet",
    weight_set_version: 7,
    weight_sources: {
      native_pools: { mode: "all" },
      lsulp: { mode: "component", component: STOKENET_LSULP_POOL, resource: STOKENET_LSULP },
      delegation: { mode: "component", component: STOKENET_DELEGATION },
    },
  });
  const doc = mirrorDoc({
    weight_set_version: 7,
    weight_sources: {
      native_pools: { mode: "all" },
      lsulp: { mode: "component", component: STOKENET_LSULP_POOL, resource: STOKENET_LSULP },
    },
  });
  const gw = mirrorGateway({ lsulpDetails: lsulpDetails(STOKENET_LSULP_POOL, STOKENET_LSULP) });
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD, { weightSet });
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
  // The whole register was applied: the pair was priced on the component's own network.
  assert.equal(callsNaming(gw, [STOKENET_LSULP_POOL]).length, 2, gw.calls.join("\n"));
  assert.deepEqual(callsNaming(gw, [STOKENET_DELEGATION]), []);
});

test("(g) \"network_independent\": a registry on another network applies no named leg, sends none of its addresses, and is a MATCH", async () => {
  const { parsePinnedWeightSet } = await import("../src/document.ts");
  const weightSet = parsePinnedWeightSet({
    network: "mainnet",
    weight_set_version: 7,
    weight_sources: {
      native_pools: { mode: "allowlist", pools: [MAINNET_NATIVE_POOL] },
      lsulp: { mode: "component", component: MAINNET_LSULP_POOL, resource: MAINNET_LSULP },
      precision_pools: { mode: "allowlist", pools: [MAINNET_PRECISION] },
      shape_pools: { mode: "allowlist", pools: [MAINNET_SHAPE] },
      delegation: { mode: "component", component: MAINNET_DELEGATION },
    },
  });
  // `weight_set_version` names the full set; `weight_sources` is the scoped subset.
  const doc = mirrorDoc(
    { weight_set_version: 7, weight_sources: { native_pools: { mode: "off" } } },
    { oter_register_scope: "network_independent" },
  );
  const gw = mirrorGateway();
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD, { weightSet });
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
  assert.deepEqual(callsNaming(gw, MAINNET_REGISTER_ADDRESSES), []);
});

test("(g) a document claiming \"full\" across networks differs by name on oter_register_scope", async () => {
  const { parsePinnedWeightSet } = await import("../src/document.ts");
  const weightSet = parsePinnedWeightSet({
    network: "mainnet",
    weight_set_version: 7,
    weight_sources: { native_pools: { mode: "all" } },
  });
  const doc = mirrorDoc({ weight_set_version: 7 }); // claims "full", carries { native_pools: all }
  const outcome = await verifyTallyDocument(doc, null, mirrorGateway(), XRD, { weightSet });
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  assert.deepEqual(outcome.differences, [
    { field: "ballot_source.(g) oter_register_scope", document: "full", recomputed: "network_independent" },
  ]);
});

test("(g) without a supplied set, a \"full\" document naming another network's pair differs by name and the pair is never sent", async () => {
  const doc = mirrorDoc({
    weight_sources: {
      native_pools: { mode: "all" },
      lsulp: { mode: "component", component: MAINNET_LSULP_POOL, resource: MAINNET_LSULP },
    },
  });
  const gw = mirrorGateway();
  const outcome = await verifyTallyDocument(doc, null, gw, XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  assert.deepEqual(
    outcome.differences.map((d) => d.field),
    ["ballot_source.(g) oter_register_scope", "ballot_source.(g) weight_sources"],
  );
  assert.equal(outcome.differences[0]?.recomputed, "network_independent");
  assert.equal(outcome.differences[1]?.recomputed, '{"native_pools":{"mode":"all"}}');
  assert.deepEqual(callsNaming(gw, [MAINNET_LSULP_POOL, MAINNET_LSULP]), []);
});

test("(g) a v3 document without oter_register_scope, or with another value, is MALFORMED", async () => {
  const missing = mirrorDoc();
  delete (missing["ballot_source"] as Record<string, unknown>)["oter_register_scope"];
  const outMissing = await verifyTallyDocument(missing, null, mirrorGateway(), XRD);
  assert.equal(outMissing.kind, "malformed");
  assert.ok(outMissing.kind === "malformed" && outMissing.reason.includes("ballot_source.oter_register_scope"));

  const other = mirrorDoc({}, { oter_register_scope: "partial" });
  const outOther = await verifyTallyDocument(other, null, mirrorGateway(), XRD);
  assert.equal(outOther.kind, "malformed");
  assert.ok(outOther.kind === "malformed" && outOther.reason.includes("ballot_source.oter_register_scope"));
});

test("(g) a supplied set without weight_sources is refused rather than read as the default register", async () => {
  const { parsePinnedWeightSet, DocumentError } = await import("../src/document.ts");
  for (const set of [{ network: "stokenet", weight_set_version: 7 }, { network: "stokenet", weight_set_version: 7, weight_sources: null }]) {
    assert.throws(
      () => parsePinnedWeightSet(set),
      (e: unknown) => e instanceof DocumentError && e.message.includes("weight_sources"),
    );
  }
});

test("(g) a supplied set naming an address off its own network is refused", async () => {
  const { parsePinnedWeightSet, DocumentError } = await import("../src/document.ts");
  assert.throws(
    () =>
      parsePinnedWeightSet({
        network: "stokenet",
        weight_set_version: 7,
        weight_sources: { native_pools: { mode: "allowlist", pools: [MAINNET_NATIVE_POOL] } },
      }),
    (e: unknown) => e instanceof DocumentError && e.message.includes(MAINNET_NATIVE_POOL),
  );
});
