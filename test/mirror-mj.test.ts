/**
 * A Majority Judgment mirror, driven end to end: the official `Governance` component's
 * `majority_judgment_elections` entry, its round's `voters` store, the Temperature Check that
 * carries the parameter set, candidates, role and seat count, and both legs' seating.
 *
 * The fixture is the same three graded ballots as the published golden round: A 50, B 30, C 20,
 * every candidate settling at Good under the round's own floor. Both rules weigh these ballots
 * identically (the stokenet allowlist names no DEX position), so both legs seat candidate 0.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { ELIGIBLE_DERIVATION, FRAMEWORK_SOURCE } from "../src/framework.ts";
import { OFFICIAL_RULE_TEXT, readOfficialEntry } from "../src/mirror.ts";
import { verifyTallyDocument } from "../src/verify.ts";
import { XRD_WEIGHT_RULE } from "../src/weight-rule.ts";

import { FakeGateway, SNAPSHOT_SV, XRD } from "./fake-gateway.ts";

const hash = (doc: Record<string, unknown>): string => tallyHash(doc as unknown as Json);

const COMPONENT = "component_tdx_2_1cp0governance000000000000000000000000000000000007";
const STOKENET_ALLOWLIST_HASH = "c2c013c86a9c92e22f966f3d8617768f8b7a44c902adcc097bfa1e098afb4e1f";
const ELECTIONS_KVS = "internal_keyvaluestore_rdx1kvelections00000000000000000000000000001";
const TC_KVS = "internal_keyvaluestore_rdx1kvtc00000000000000000000000000000000000002";
const VOTERS_KVS = "internal_keyvaluestore_rdx1kvvoters000000000000000000000000000000003";
const VALIDATOR = "validator_rdx1vvv";

const A = "account_rdx1alice000000000000000000000000000000000000000000001";
const B = "account_rdx1bob00000000000000000000000000000000000000000000002";
const C = "account_rdx1carol00000000000000000000000000000000000000000000003";

const OFFICIAL_SNAPSHOT = 1754000000;
const OFFICIAL_DEADLINE = 1754604800;
const BALLOT_SV = SNAPSHOT_SV + 50;
const ENTRY_SV = BALLOT_SV + 25;

const s = (field_name: string, value: string) => ({ field_name, value });
const option = (field_name: string, value: string) => ({
  field_name,
  kind: "Tuple",
  fields: [{ kind: "U32", value }],
});

/** The OTER leg's `majority_judgment` block, pinned from the three ballots. */
const MJ_BLOCK = {
  grades: ["Excellent", "Very Good", "Good", "Acceptable", "Poor"],
  minimum_qualifying_grade: "Good",
  grade_quantile: { numerator: 3, denominator: 5 },
  candidates: [
    {
      candidate_index: 0,
      by_grade: ["50", "0", "50", "0", "0"],
      cast: "100",
      qualifying_grade: 2,
      above: "50",
      below: "0",
    },
    {
      candidate_index: 1,
      by_grade: ["0", "30", "70", "0", "0"],
      cast: "100",
      qualifying_grade: 2,
      above: "30",
      below: "0",
    },
    {
      candidate_index: 2,
      by_grade: ["0", "20", "30", "50", "0"],
      cast: "100",
      qualifying_grade: 3,
      above: "50",
      below: "0",
    },
  ],
  referred_tie_unresolved: [] as number[],
  invalid_ballots: [] as number[],
};

function mjDocument(over: Record<string, unknown> = {}, ballotSourceOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tally_doc_version: 22,
    consultation_id: "official:majority_judgment_election:0",
    kind: "Election",
    options: ["Alice", "Bob", "Carol"],
    snapshot_state_version: SNAPSHOT_SV,
    space_id: 0,
    weight_config: { kind: "Xrd" },
    term_seconds: 0,
    asset_symbol: "XRD",
    weight_rule: XRD_WEIGHT_RULE,
    weight_sources: { native_pools: { mode: "all" } },
    weight_set_version: 0,
    excluded_set_version: 0,
    excluded_accounts: [],
    delegation_input: null,
    delegations: null,
    delegated_weight_total: null,
    votes: [
      { account: A, selection: [0, 7, 13], weight: "50" },
      { account: B, selection: [2, 6, 12], weight: "30" },
      { account: C, selection: [2, 7, 11], weight: "20" },
    ],
    totals: ["50", "0", "50", "0", "0", "0", "30", "70", "0", "0", "0", "20", "30", "50", "0"],
    total_weight: "100",
    abstain_weight: "0",
    voter_count: 3,
    quorum: "100",
    approval_threshold_pc: "0",
    min_affirmative_support: "0",
    min_unique_voters: 0,
    quorum_met: true,
    mas_met: null,
    seats: 1,
    seat_rule: "MajorityJudgment",
    majority_judgment: MJ_BLOCK,
    winners: [0],
    withdrawn_excluded: [],
    approve_weight: null,
    reject_weight: null,
    approved: null,
    eligible_voting_power: "1428.571428571428571428",
    category: "mirror:majority_judgment_election:0",
    ballot_source: {
      mirror_doc_version: 3,
      component: COMPONENT,
      blueprint: "Governance",
      kind: "majority_judgment_election",
      official_id: 0,
      official_start: OFFICIAL_SNAPSHOT,
      official_deadline: OFFICIAL_DEADLINE,
      official_quorum: "100",
      official_approval_threshold: "0",
      official_vote_count: 3,
      official_revote_count: 0,
      ballot_count: 3,
      ballot_state_version: BALLOT_SV,
      official_entry_state_version: ENTRY_SV,
      ballots_outside_window: 0,
      official_rule: {
        rule: OFFICIAL_RULE_TEXT,
        allowlist_version: "2026-09-06",
        allowlist_hash: STOKENET_ALLOWLIST_HASH,
        totals: ["50", "0", "50", "0", "0", "0", "30", "70", "0", "0", "0", "20", "30", "50", "0"],
        totals_by_source: null,
        total_weight: "100",
        quorum_met: true,
        approved: null,
        winners: [0],
        majority_judgment: MJ_BLOCK,
      },
      weight_delta_by_source: null,
      official_snapshot: OFFICIAL_SNAPSHOT,
      official_parameter_set: {
        id: "dao-election",
        label: "Majority Judgment Election",
        version: 1,
        variant: "MajorityJudgment",
      },
      official_outcome: null,
      official_continuation: null,
      official_max_selections: null,
      framework: {
        source: FRAMEWORK_SOURCE,
        quorum_pc: "7",
        mas_pc: "0",
        min_unique_voters: 0,
        eligible_voting_power_derivation: ELIGIBLE_DERIVATION,
        eligible_voting_power_bound: "14.285714285714285714",
      },
      oter_register_scope: "full",
      official_round: "RoundOne",
      official_role_id: "rac-seat",
      official_candidate_references: ["candidate-alice", "candidate-bob", "candidate-carol"],
      official_tie_resolution: null,
      ...ballotSourceOver,
    },
    ...over,
  };
}

function componentDetails(): unknown {
  return {
    items: [
      {
        address: COMPONENT,
        details: {
          blueprint_name: "Governance",
          state: {
            fields: [
              { field_name: "temperature_checks", value: TC_KVS },
              { field_name: "majority_judgment_elections", value: ELECTIONS_KVS },
            ],
          },
        },
      },
    ],
  };
}

function electionEntry(): unknown {
  const round = {
    kind: "Struct",
    fields: [
      s("snapshot", String(OFFICIAL_SNAPSHOT)),
      s("start", String(OFFICIAL_SNAPSHOT)),
      s("deadline", String(OFFICIAL_DEADLINE)),
      s("quorum", "100"),
      {
        field_name: "minimum_median_grade",
        kind: "Enum",
        variant_id: "2",
        variant_name: "Good",
        fields: [],
      },
      s("voters", VOTERS_KVS),
      s("vote_count", "3"),
      s("revote_count", "0"),
    ],
  };
  return {
    entries: [
      {
        value: {
          programmatic_json: {
            fields: [
              s("temperature_check_id", "7"),
              { field_name: "round_one", kind: "Enum", variant_name: "Some", fields: [round] },
              { field_name: "rerun", kind: "Enum", variant_name: "None", fields: [] },
              { field_name: "tie_resolution", kind: "Enum", variant_name: "None", fields: [] },
              s("hidden", "false"),
            ],
          },
        },
        last_updated_at_state_version: ENTRY_SV,
      },
    ],
  };
}

function temperatureCheckEntry(): unknown {
  return {
    entries: [
      {
        value: {
          programmatic_json: {
            fields: [
              {
                field_name: "parameter_set",
                kind: "Tuple",
                fields: [
                  s("id", "dao-election"),
                  s("label", "Majority Judgment Election"),
                  s("version", "1"),
                  {
                    field_name: "parameters",
                    kind: "Enum",
                    variant_name: "MajorityJudgment",
                    fields: [
                      {
                        field_name: "temperature_check",
                        kind: "Tuple",
                        fields: [s("voting_days", "5"), s("quorum", "100"), s("approval_threshold", "0")],
                      },
                    ],
                  },
                ],
              },
              {
                field_name: "follow_up",
                kind: "Enum",
                variant_name: "MajorityJudgmentElection",
                fields: [
                  s("role_id", "rac-seat"),
                  s("seat_count", "1"),
                  {
                    field_name: "candidates",
                    kind: "Array",
                    elements: [
                      {
                        fields: [
                          option("id", "0"),
                          s("display_name", "Alice"),
                          s("reference", "candidate-alice"),
                        ],
                      },
                      {
                        fields: [
                          option("id", "1"),
                          s("display_name", "Bob"),
                          s("reference", "candidate-bob"),
                        ],
                      },
                      {
                        fields: [
                          option("id", "2"),
                          s("display_name", "Carol"),
                          s("reference", "candidate-carol"),
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        last_updated_at_state_version: ENTRY_SV - 10,
      },
    ],
  };
}

/** A grade ballot: `candidate_id` is a U32 newtype, `grade` an official enum. */
function grade(candidate: number, id: string, name: string): unknown {
  return {
    fields: [
      option("candidate_id", String(candidate)),
      { field_name: "grade", kind: "Enum", variant_id: id, variant_name: name, fields: [] },
    ],
  };
}

function voter(account: string, grades: unknown[], sv: number): unknown {
  return {
    key: { programmatic_json: { value: account } },
    value: {
      programmatic_json: {
        fields: [
          s("vote_id", "1"),
          { field_name: "grades", kind: "Array", elements: grades },
        ],
      },
    },
    last_updated_at_state_version: sv,
  };
}

function votersData(): unknown {
  return {
    entries: [
      voter(A, [grade(0, "4", "Excellent"), grade(1, "2", "Good"), grade(2, "1", "Acceptable")], SNAPSHOT_SV + 10),
      voter(B, [grade(0, "2", "Good"), grade(1, "3", "VeryGood"), grade(2, "2", "Good")], SNAPSHOT_SV + 20),
      voter(C, [grade(0, "2", "Good"), grade(1, "2", "Good"), grade(2, "3", "VeryGood")], BALLOT_SV),
    ],
  };
}

function accountsDetails(): unknown {
  return {
    items: [
      { address: A, fungible_resources: { items: [{ resource_address: XRD, amount: "50" }] } },
      { address: B, fungible_resources: { items: [{ resource_address: XRD, amount: "30" }] } },
      { address: C, fungible_resources: { items: [{ resource_address: XRD, amount: "20" }] } },
    ],
  };
}

function validators(): unknown {
  return {
    validators: {
      next_cursor: null,
      items: [
        { address: VALIDATOR, stake_vault: { balance: "0" }, state: { stake_unit_resource_address: "resource_rdx1lsu" } },
      ],
    },
  };
}

function gateway(overrides: { ballots?: unknown; entry?: unknown; tc?: unknown } = {}): FakeGateway {
  return new FakeGateway()
    .onDetails(componentDetails())
    .onKvsKeys(ELECTIONS_KVS, { items: [{ key: { programmatic_json: { value: "0" } } }], next_cursor: null })
    .onKvsKeys(TC_KVS, { items: [{ key: { programmatic_json: { value: "7" } } }], next_cursor: null })
    .onKvsKeys(VOTERS_KVS, {
      items: [A, B, C].map((a) => ({ key: { programmatic_json: { value: a } } })),
      next_cursor: null,
    })
    .onKvsDataAt(ELECTIONS_KVS, ENTRY_SV, overrides.entry ?? electionEntry())
    .onKvsDataAt(TC_KVS, ENTRY_SV, overrides.tc ?? temperatureCheckEntry())
    .onKvsData(VOTERS_KVS, overrides.ballots ?? votersData())
    .onDetails(accountsDetails()) // (b) official-rule weights
    .onValidators(validators())
    .onTimestampDetailsAt(OFFICIAL_SNAPSHOT, { ledger_state: { state_version: SNAPSHOT_SV } })
    .onTimestampDetailsAt(OFFICIAL_DEADLINE, { ledger_state: { state_version: BALLOT_SV } })
    .onDetails(accountsDetails()) // (c) the OTER-rule weights
    .onValidators(validators());
}

test("a Majority Judgment mirror: both legs seat the same candidate, MATCH", async () => {
  const doc = mjDocument();
  const outcome = await verifyTallyDocument(doc, hash(doc), gateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("a Majority Judgment mirror: a wrong round is a figures-class finding", async () => {
  const doc = mjDocument({}, { official_round: "Rerun" });
  const outcome = await verifyTallyDocument(doc, hash(doc), gateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind === "figures") {
    assert.deepEqual(
      outcome.differences.find((d) => d.field === "ballot_source.(a) official_round"),
      { field: "ballot_source.(a) official_round", document: "Rerun", recomputed: "RoundOne" },
    );
  }
});

test("a Majority Judgment mirror: official_rule.winners is recomputed, not believed", async () => {
  const doc = mjDocument();
  (doc["ballot_source"] as Record<string, unknown>)["official_rule"] = {
    ...((doc["ballot_source"] as Record<string, unknown>)["official_rule"] as Record<string, unknown>),
    winners: [1],
  };
  const outcome = await verifyTallyDocument(doc, hash(doc), gateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind === "figures") {
    assert.deepEqual(
      outcome.differences.find((d) => d.field === "ballot_source.(b) official_rule.winners"),
      { field: "ballot_source.(b) official_rule.winners", document: "[1]", recomputed: "[0]" },
    );
  }
});

test("a rerun entry reads its own round, snapshot and recorded tie order", async () => {
  const rerunRound = {
    kind: "Struct",
    fields: [
      s("snapshot", "1790000000"),
      s("start", "1790000100"),
      s("deadline", "1790200000"),
      s("quorum", "250"),
      { field_name: "minimum_median_grade", kind: "Enum", variant_id: "3", variant_name: "VeryGood", fields: [] },
      s("voters", VOTERS_KVS),
      s("vote_count", "9"),
      s("revote_count", "2"),
    ],
  };
  const entry = {
    entries: [
      {
        value: {
          programmatic_json: {
            fields: [
              s("temperature_check_id", "7"),
              { field_name: "round_one", kind: "Enum", variant_name: "None", fields: [] },
              { field_name: "rerun", kind: "Enum", variant_name: "Some", fields: [rerunRound] },
              {
                field_name: "tie_resolution",
                kind: "Enum",
                variant_name: "Some",
                fields: [
                  {
                    kind: "Struct",
                    fields: [
                      { field_name: "round", kind: "Enum", variant_name: "Rerun", fields: [] },
                      {
                        field_name: "ordered_candidate_ids",
                        kind: "Array",
                        elements: [option("id", "2"), option("id", "1"), option("id", "0")],
                      },
                    ],
                  },
                ],
              },
              s("hidden", "false"),
            ],
          },
        },
        last_updated_at_state_version: ENTRY_SV,
      },
    ],
  };
  const gw = new FakeGateway()
    .onDetails(componentDetails())
    .onKvsKeys(ELECTIONS_KVS, { items: [{ key: { programmatic_json: { value: "0" } } }], next_cursor: null })
    .onKvsKeys(TC_KVS, { items: [{ key: { programmatic_json: { value: "7" } } }], next_cursor: null })
    .onKvsDataAt(ELECTIONS_KVS, ENTRY_SV, entry)
    .onKvsDataAt(TC_KVS, ENTRY_SV, temperatureCheckEntry());
  const read = await readOfficialEntry(
    gw,
    COMPONENT,
    "majority_judgment_election_rerun",
    0,
    ENTRY_SV,
  );
  assert.equal(read.round, "Rerun");
  assert.equal(read.snapshot, 1790000000);
  assert.equal(read.start, 1790000100);
  assert.equal(read.quorum.toString(), "250");
  assert.equal(read.minimumGradeIndex, 1, "VeryGood");
  assert.deepEqual(read.tieResolution, [2, 1, 0]);
  assert.deepEqual(read.voteOptions, ["Alice", "Bob", "Carol"]);
});

test("a Majority Judgment mirror: a grade enum whose id and name disagree is refused", async () => {
  const bad = votersData() as { entries: Array<{ value: { programmatic_json: { fields: unknown[] } } }> };
  const grades = (bad.entries[0]!.value.programmatic_json.fields[1] as { elements: unknown[] }).elements;
  grades[0] = {
    fields: [
      option("candidate_id", "0"),
      { field_name: "grade", kind: "Enum", variant_id: "4", variant_name: "Poor", fields: [] },
    ],
  };
  const outcome = await verifyTallyDocument(mjDocument(), null, gateway({ ballots: bad }), XRD);
  assert.equal(outcome.kind, "malformed");
  if (outcome.kind === "malformed") {
    assert.match(outcome.reason, /variant_id 4 and variant_name "Poor" disagree/);
  }
});
