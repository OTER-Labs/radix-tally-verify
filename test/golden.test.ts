/**
 * The published encoding and mirror vectors, pinned as fixtures.
 *
 * The v22 vector pins the four space keys' canonical rendering and its hash. The two mirror
 * vectors pin the whole v3 document — a Temperature Check and a Majority Judgment round — by
 * their canonical bytes and hashes, and the byte fragments the reference engine's own golden
 * tests assert. The CLI's `--hash-only` path is exercised on all three, so the encodings can be
 * checked with no Gateway at all.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalize, tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { parseTallyDocument } from "../src/document.ts";
import { ELIGIBLE_DERIVATION, FRAMEWORK_SOURCE } from "../src/framework.ts";
import { OFFICIAL_RULE_TEXT } from "../src/mirror.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

function load(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Json;
}

const V22_CANONICAL =
  '{"asset_symbol":"TAHU","consultation_id":"golden-v22","space_id":7,"term_seconds":31536000,' +
  '"total_weight":"1000","version":22,"weight_config":{"kind":"Fungible",' +
  '"resource":"resource_rdx1t4golden"}}';
const V22_HASH = "5962fc7e825bb75c52fda7ab43ef217b29bc674fa401cb1e38f9b6d33ffdecfc";

const TC_HASH = "c71d6eda9871cc1c1621aced25ab8292160c164cf66e27259c26afd42c3f7055";
const MJ_HASH = "58c133e8993b4092a8fe909de1f4a02d8f29f2999e015b323fd07bd840f4c5cd";

const q = (s: string): string => JSON.stringify(s);

test("the v22 space keys hash to the published value", () => {
  const doc = load("golden-v22.json");
  assert.equal(canonicalize(doc), V22_CANONICAL);
  assert.equal(tallyHash(doc), V22_HASH);
});

test("the v3 Temperature Check mirror's canonical bytes carry the reference fragments", () => {
  const doc = load("golden-v3-tc-mirror.json");
  const canonical = canonicalize(doc);
  const prefix =
    '{"abstain_allowed":true,"abstain_weight":"0","approval_threshold_pc":"50",' +
    '"approve_weight":"1300","approved":true,"asset_symbol":"XRD","ballot_source":' +
    '{"ballot_count":3,"ballot_state_version":542970896,"ballots_outside_window":0,' +
    '"blueprint":"Governance","component":"component_rdx1czn_official","framework":' +
    '{"eligible_voting_power_bound":"33.333333333333333333",' +
    `"eligible_voting_power_derivation":${q(ELIGIBLE_DERIVATION)},` +
    '"mas_pc":"0","min_unique_voters":0,"quorum_pc":"3",' +
    `"source":${q(FRAMEWORK_SOURCE)}},"kind":"temperature_check","mirror_doc_version":3,` +
    '"official_approval_threshold":"0.5","official_continuation":{"id":6,"kind":"proposal"},' +
    '"official_deadline":1785431200,"official_entry_state_version":542970990,' +
    '"official_id":5,"official_max_selections":null,' +
    '"official_outcome":{"recorded_at":1785431500,"result":"Passed"},' +
    '"official_parameter_set":{"id":"default","label":"Standard Executable",' +
    '"variant":"Standard","version":2},"official_quorum":"1000",' +
    '"official_revote_count":1,"official_rule":' +
    '{"allowlist_hash":"bfadafb515c346c6f44b18f18a0ea71bd019523193ff49db7a8f6c53d704946f",' +
    '"allowlist_version":"2026-09-06","approved":false,"quorum_met":false,' +
    `"rule":${q(OFFICIAL_RULE_TEXT)}`;
  assert.ok(canonical.startsWith(prefix), `canonical prefix drifted:\n${canonical.slice(0, 1200)}`);

  const middle =
    ',"total_weight":"800","totals":["400","400"],"totals_by_source":' +
    '{"liquid":"800","lsu":"0","lsulp":"0","pool_units":"0","precision_pools":"0",' +
    '"shape_pools":"0"}},"official_snapshot":1784999200,"official_start":1784999200,' +
    '"official_vote_count":4,"oter_register_scope":"full","weight_delta_by_source":' +
    '{"lsu":"0","lsulp":"0","pool_units":"900","precision_pools":"0","shape_pools":"0"}},' +
    '"category":"mirror:temperature_check:5",' +
    '"consultation_id":"official:temperature_check:5","delegated_weight_total":null,' +
    '"delegation_input":null,"delegations":null,' +
    '"eligible_voting_power":"33333.333333333333333333","excluded_accounts":[],';
  assert.ok(canonical.includes(middle), "the official_rule / metadata block drifted");

  assert.equal(tallyHash(doc), TC_HASH);
});

test("the v3 Majority Judgment mirror has the Election shape the reference publishes", () => {
  const doc = load("golden-v3-mj-mirror.json") as Record<string, unknown>;
  const src = doc["ballot_source"] as Record<string, unknown>;
  const rule = src["official_rule"] as Record<string, unknown>;
  const block = doc["majority_judgment"] as Record<string, unknown>;
  assert.equal(doc["kind"], "Election");
  assert.equal(doc["seats"], 1);
  assert.equal(doc["final_seats"], 0);
  assert.equal(doc["seat_rule"], "MajorityJudgment");
  assert.deepEqual(doc["withdrawn_excluded"], []);
  assert.deepEqual(doc["winners"], [0]);
  assert.deepEqual(doc["options"], ["Alice", "Bob", "Carol"]);
  assert.equal((doc["totals"] as unknown[]).length, 15);
  assert.equal(block["minimum_qualifying_grade"], "Good");
  assert.deepEqual(block["grade_quantile"], { numerator: 3, denominator: 5 });
  assert.deepEqual(
    ((block["candidates"] as Array<Record<string, unknown>>)[0]!["by_grade"] as string[])[0],
    "50",
  );
  for (const key of ["approved", "approve_weight", "reject_weight", "mas_met"]) {
    assert.equal(doc[key], null, key);
  }
  assert.equal(doc["eligible_voting_power"], "1428.571428571428571428");
  assert.equal(src["official_round"], "RoundOne");
  assert.equal(src["official_role_id"], "rac-seat");
  assert.deepEqual(src["official_candidate_references"], [
    "candidate-alice",
    "candidate-bob",
    "candidate-carol",
  ]);
  assert.equal(src["official_tie_resolution"], null);
  assert.deepEqual(rule["winners"], [0]);
  assert.equal(rule["approved"], null);
  assert.equal((rule["majority_judgment"] as Record<string, unknown>)["minimum_qualifying_grade"], "Good");
  assert.equal(tallyHash(doc as unknown as Json), MJ_HASH);
});

test("the golden mirror documents parse as tally documents", () => {
  const tc = parseTallyDocument(load("golden-v3-tc-mirror.json"));
  assert.equal(tc.doc.isMirror, true);
  assert.equal(tc.doc.ballotSource?.kind, "temperature_check");
  assert.equal(tc.doc.ballotSource?.officialRound, null);
  assert.equal(tc.doc.weightRule !== null, true);

  const mj = parseTallyDocument(load("golden-v3-mj-mirror.json"));
  assert.equal(mj.doc.isMirror, true);
  assert.equal(mj.doc.kind, "Election");
  assert.equal(mj.doc.seatRule, "MajorityJudgment");
  assert.equal(mj.doc.ballotSource?.kind, "majority_judgment_election");
  assert.equal(mj.doc.ballotSource?.officialRound, "RoundOne");
  assert.equal(mj.doc.ballotSource?.officialRoleId, "rac-seat");
  assert.deepEqual(mj.doc.ballotSource?.officialCandidateReferences, [
    "candidate-alice",
    "candidate-bob",
    "candidate-carol",
  ]);
  assert.equal(mj.doc.ballotSource?.officialTieResolution, null);
  assert.equal(mj.doc.ballotSource?.officialRule.winners?.join(","), "0");
  assert.equal(mj.doc.minimumQualifyingGrade, 2);
});

test("the CLI checks every golden encoding offline with --hash-only", () => {
  const cli = join(HERE, "..", "src", "cli.ts");
  const run = (fixture: string): string =>
    execFileSync(process.execPath, ["--experimental-strip-types", cli, join(FIXTURES, fixture), "--hash-only"], {
      encoding: "utf8",
    });
  assert.match(run("golden-v22.json"), new RegExp(`hash=${V22_HASH}`));
  assert.match(run("golden-v3-tc-mirror.json"), new RegExp(`hash=${TC_HASH}`));
  assert.match(run("golden-v3-mj-mirror.json"), new RegExp(`hash=${MJ_HASH}`));
});
