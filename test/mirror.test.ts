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
import { verifyTallyDocument } from "../src/verify.ts";

import { FakeGateway, SNAPSHOT_SV, XRD } from "./fake-gateway.ts";

const hash = (doc: Record<string, unknown>): string => tallyHash(doc as unknown as Json);

// A STOKENET governance component: `officialAllowlistFor` picks the shipped list by the
// address's own bech32 prefix, and the stokenet list names no DEX position (none of the three
// DEXes deploys there), so the official rule here is direct XRD plus every active validator's
// LSUs — Tier 1, and exactly what a test stack can produce. The mainnet list's own content and
// hash are checked directly in `allowlist.test.ts` rather than driven through a fake Gateway
// that would have to serve sixty-nine pools.
const COMPONENT = "component_tdx_2_1cp0governance000000000000000000000000000000000007";
/** blake2b-256 of the canonical `[]` — the stokenet list's `allowlist_hash`. */
const STOKENET_ALLOWLIST_HASH = "c2c013c86a9c92e22f966f3d8617768f8b7a44c902adcc097bfa1e098afb4e1f";
const OFFICIAL_RULE_TEXT =
  "The Radix DAO Consultation App's own rule at snapshot_state_version: direct XRD at par, plus " +
  "the stake units of every active validator at their underlying XRD value, plus LSULP at its " +
  "underlying liquid-staked XRD value, plus the XRD, LSU and LSULP side of each position on the " +
  "app's static DEX allowlist.";
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

/** A mirror tally document over the fixture Temperature Check: liquid-only For, staked For,
 * Against revoter.
 *
 * The two rules AGREE here, and that is the case worth pinning: validator LSUs are Tier 1 in
 * both, the stokenet allowlist names no pool, and nobody holds one — so both legs read Against
 * 30, For 145 (120 liquid + the staked voter's 25 XRD of LSU), total 175, and every
 * `weight_delta_by_source` leg is zero. A staked voter weighing the same under both rules is the
 * whole point of #172: before it, this fixture's official leg dropped the 25. Both use the
 * official absolute quorum 100 / threshold 50. */
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
    ballot_source: {
      mirror_doc_version: 2,
      component: COMPONENT,
      blueprint: "Governance",
      kind: "temperature_check",
      official_id: 5,
      official_start: OFFICIAL_START,
      official_deadline: OFFICIAL_DEADLINE,
      official_quorum: "100",
      official_approval_threshold: "50",
      official_vote_count: 4,
      official_revote_count: 1,
      ballot_count: 3,
      ballot_state_version: BALLOT_SV,
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

function tcRegisterData(entryOver: Record<string, string> = {}): unknown {
  const fields: Record<string, string> = {
    voters: VOTERS_KVS,
    quorum: "100",
    approval_threshold: "50",
    start: String(OFFICIAL_START),
    deadline: String(OFFICIAL_DEADLINE),
    vote_count: "4",
    revote_count: "1",
    ...entryOver,
  };
  return {
    entries: [
      {
        value: {
          programmatic_json: {
            fields: Object.entries(fields).map(([field_name, value]) => ({ field_name, value })),
          },
        },
      },
    ],
  };
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
  votersData?: unknown;
  startSv?: number;
  deadlineSv?: number | null;
} = {}): FakeGateway {
  const gw = new FakeGateway()
    .onDetails(overrides.componentDetails ?? componentDetails())
    .onDetails(accountsFungibles()) // (b) official-rule breakdown, under the ALLOWLIST register
    .onDetails(resourceInfo()) // (b) its held-resource info
    .onDetails(accountsFungibles()) // (e) OTER-rule breakdown fungibles
    .onDetails(resourceInfo()) // (e) weight-breakdown held-resource info
    .onDetails(accountsFungibles()) // (c) the ordinary OTER-rule pipeline
    .onDetails(resourceInfo()) // (c) the ordinary OTER-rule pipeline
    .onValidators(validatorsResponse())
    .onValidators(validatorsResponse())
    .onValidators(validatorsResponse())
    .onTimestampDetails(timestampDetails(overrides.startSv ?? SNAPSHOT_SV)); // (d) official_start
  const deadlineSv = "deadlineSv" in overrides ? overrides.deadlineSv : BALLOT_SV;
  if (deadlineSv !== null) {
    gw.onTimestampDetails(timestampDetails(deadlineSv)); // (d) official_deadline, window closed
  }
  return gw
    .onKvsKeys(TC_REGISTER_KVS, tcRegisterKeys())
    .onKvsData(TC_REGISTER_KVS, overrides.tcRegisterData ?? tcRegisterData())
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
 * engine's `compute_tally` writes them on every document unconditionally, mirror or not, and a
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

/** The pre-#172 number: an official leg that read liquid XRD only put 120 on the For side and
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
  // `deadline_state_version = i64::MAX`), so no `entityDetailsAtTimestamp` call is even made for
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
  // The pre-#172 claim: "the LSU leg is what the official rule drops". Both rules count it now,
  // so the honest delta is zero and a document still claiming 25 is claiming a rule nobody applies.
  assert.equal(d?.document, "25");
  assert.equal(d?.recomputed, "0");
});
