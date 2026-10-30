/**
 * Document v23: sealed ballots.
 *
 * The cryptographic core is checked against the engine's own fixtures (Task 8's `ballots.json`
 * and `round_1000.json`, copied verbatim): the round arithmetic, the round-1000 signature, a
 * flipped signature, and each fixture's recorded result. The document checks are then checked
 * for the two things a sealed tally can lie about — the selection a ciphertext opens to, and
 * which side of `round_time` a ballot falls on — plus the compatibility promise that a v22
 * document still verifies unchanged.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { TALLY_DOC_VERSION, parseTallyDocument } from "../src/document.ts";
import { compareSealedBallotEvents } from "../src/events.ts";
import type { SealedBallotEvent } from "../src/events.ts";
import {
  SEALED_PLAINTEXT_TAG,
  QUICKNET_CHAIN,
  openBallot,
  sealingRound,
  validatePlaintext,
  verifyRoundSignature,
} from "../src/sealed.ts";
import type { SealedChain, SealedInvalid, SelectionRules } from "../src/sealed.ts";
import { verifyTallyDocument } from "../src/verify.ts";
import {
  SEALED_WEIGHT_RULE_SENTENCES,
  XRD_WEIGHT_RULE,
  XRD_WEIGHT_RULE_V22,
  weightRuleText,
} from "../src/weight-rule.ts";

import { ACCOUNT_A, FakeGateway, scenarioGateway } from "./fake-gateway.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "sealed");

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

const ROUND_FIXTURE = load("round_1000.json");
const BALLOTS = load("ballots.json") as {
  consultation_id: string;
  account: string;
  round: number;
  rules: {
    abstain_allowed: boolean;
    max_selections: number;
    candidate_count: number;
    majority_judgment: boolean;
    option_count: number;
  };
  ballots: Array<{
    name: string;
    plaintext: string;
    round: number;
    ciphertext: string;
    expected: { ok?: number[]; invalid?: SealedInvalid };
  }>;
};
const DOC_BALLOTS = load("doc_ballots.json") as {
  consultation_id: string;
  account: string;
  round: number;
  ballots: Array<{
    name: string;
    plaintext: string;
    selection?: number[];
    invalid?: SealedInvalid;
    ciphertext: string;
  }>;
};

const SIGNATURE = ROUND_FIXTURE["signature"] as string;
const ROUND = ROUND_FIXTURE["round"] as number;
/** quicknet round 1000's wall clock: genesis + (round - 1) * period. */
const ROUND_TIME = 1692806364;
const MARGIN = 300;
const VOTE_END = ROUND_TIME - MARGIN;

const fixtureBallot = (name: string): (typeof BALLOTS)["ballots"][number] => {
  const found = BALLOTS.ballots.find((b) => b.name === name);
  assert.ok(found !== undefined, `fixture ${name}`);
  return found;
};
const docBallot = (name: string): (typeof DOC_BALLOTS)["ballots"][number] => {
  const found = DOC_BALLOTS.ballots.find((b) => b.name === name);
  assert.ok(found !== undefined, `fixture ${name}`);
  return found;
};

const chain = (): SealedChain => QUICKNET_CHAIN;

/** Stokenet XRD: the reference engine's dumped documents are Stokenet documents. */
const STOKENET_XRD = "resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";

/* ------------------------------------------------------------------------------------------
 * The round, the signature, and the ciphertexts — the engine's exact arithmetic and fixtures.
 * ---------------------------------------------------------------------------------------- */

test("round matches the engine", () => {
  // Task 1's pinned vector: T = 1_700_000_300, floor((T - 1_692_803_367) / 3) = 2_398_977.
  assert.deepEqual(sealingRound(1_700_000_000, 300, chain()), {
    round: 2_398_978,
    roundTime: 1_700_000_298,
  });
  // round_time is the last boundary at or before T, and never more than one period before it.
  for (const m of [30, 31, 32, 300, 3600]) {
    const { roundTime } = sealingRound(1_800_000_001, m, chain());
    assert.ok(roundTime <= 1_800_000_001 + m);
    assert.ok(roundTime > 1_800_000_001 + m - 3);
  }
  assert.deepEqual(sealingRound(VOTE_END, MARGIN, chain()), {
    round: ROUND,
    roundTime: ROUND_TIME,
  });
});

test("round 1000 signature verifies", async () => {
  assert.equal(await verifyRoundSignature(chain(), ROUND, SIGNATURE), true);
});

test("a flipped signature is refused", async () => {
  const flipped = SIGNATURE.slice(0, -1) + (SIGNATURE.endsWith("9") ? "8" : "9");
  assert.equal(await verifyRoundSignature(chain(), ROUND, flipped), false);
});

test("plaintext format is exact", () => {
  const fixtureRules = {
    abstainAllowed: BALLOTS.rules.abstain_allowed,
    maxSelections: BALLOTS.rules.max_selections,
    candidateCount: BALLOTS.rules.candidate_count,
    majorityJudgment: BALLOTS.rules.majority_judgment,
    optionCount: BALLOTS.rules.option_count,
  };
  const account = BALLOTS.account;
  const validate = (text: string, rules = fixtureRules) =>
    validatePlaintext(text, BALLOTS.consultation_id, account, rules);
  const base = `${SEALED_PLAINTEXT_TAG}\n${BALLOTS.consultation_id}\n${account}\n0,2`;

  assert.deepEqual(validate(base), { ok: true, selection: [0, 2] });
  // Empty selection is an abstention where the vote takes one.
  assert.deepEqual(validate(`${SEALED_PLAINTEXT_TAG}\n7\n${account}\n`), { ok: true, selection: [] });
  assert.deepEqual(validate(`${SEALED_PLAINTEXT_TAG}\n7\n${account}\n`, { ...fixtureRules, abstainAllowed: false }), {
    ok: false,
    reason: "invalid_selection",
  });
  // Every departure from the exact four-line format is malformed.
  for (const text of [
    `${base}\n`,
    base.replace(/\n/g, "\r\n"),
    `${base}\nfifth`,
    base.replace(SEALED_PLAINTEXT_TAG, "oter-sealed-ballot-v2"),
    `${SEALED_PLAINTEXT_TAG}\n7\n${account}\n01`,
    `${SEALED_PLAINTEXT_TAG}\n7\n${account}\n1,,2`,
    `${SEALED_PLAINTEXT_TAG}\n7\n${account}\n-1`,
    `${SEALED_PLAINTEXT_TAG}\n7\n${account}\n99999999999999999999`,
    `${SEALED_PLAINTEXT_TAG}\n7\n${account}\n0, 2`,
    `${SEALED_PLAINTEXT_TAG}\n7\n${account}\n0,`,
  ]) {
    assert.deepEqual(validate(text), { ok: false, reason: "malformed" }, JSON.stringify(text));
  }
  // The binding comes after the format and before the selection rules.
  assert.deepEqual(validate(base.replace("\n7\n", "\n8\n")), {
    ok: false,
    reason: "wrong_vote",
  });
  // And a selection that breaks cast_vote's rules is invalid_selection.
  assert.deepEqual(validate(`${SEALED_PLAINTEXT_TAG}\n7\n${account}\n2,0`), {
    ok: false,
    reason: "invalid_selection",
  });
  assert.deepEqual(validate(`${SEALED_PLAINTEXT_TAG}\n7\n${account}\n3`), {
    ok: false,
    reason: "invalid_selection",
  });
  assert.deepEqual(
    validate(`${SEALED_PLAINTEXT_TAG}\n7\n${account}\n0,1,2`, { ...fixtureRules, maxSelections: 2 }),
    { ok: false, reason: "invalid_selection" },
  );
});

test("a corrupted armor and a signature wrong for the ciphertext are undecryptable", async () => {
  const valid = docBallot("valid_approval").ciphertext;
  // Flip one base64 character inside the armor payload; the header MAC then cannot validate.
  const at = valid.indexOf("\n", 300) + 20;
  const corrupted = valid.slice(0, at) + (valid[at] === "A" ? "B" : "A") + valid.slice(at + 1);
  assert.deepEqual(await openBallot(corrupted, chain(), ROUND, SIGNATURE), {
    ok: false,
    reason: "undecryptable",
  });

  const flipped = SIGNATURE.slice(0, -1) + (SIGNATURE.endsWith("9") ? "8" : "9");
  assert.deepEqual(await openBallot(valid, chain(), ROUND, flipped), {
    ok: false,
    reason: "undecryptable",
  });
});

test("each fixture opens to its recorded result", async () => {
  for (const ballot of BALLOTS.ballots) {
    const opened = await openBallot(ballot.ciphertext, chain(), BALLOTS.round, SIGNATURE);
    const expected = ballot.expected;
    if (expected.invalid !== undefined && (expected.invalid === "undecryptable" || expected.invalid === "wrong_round")) {
      assert.deepEqual(opened, { ok: false, reason: expected.invalid }, ballot.name);
      continue;
    }
    assert.ok(opened.ok, `${ballot.name}: ${opened.ok ? "" : opened.reason}`);
    if (!opened.ok) continue;
    const validated = validatePlaintext(
      opened.plaintext,
      BALLOTS.consultation_id,
      BALLOTS.account,
      {
        abstainAllowed: BALLOTS.rules.abstain_allowed,
        maxSelections: BALLOTS.rules.max_selections,
        candidateCount: BALLOTS.rules.candidate_count,
        majorityJudgment: BALLOTS.rules.majority_judgment,
        optionCount: BALLOTS.rules.option_count,
      },
    );
    if (expected.ok !== undefined) {
      assert.deepEqual(validated, { ok: true, selection: expected.ok }, ballot.name);
    } else {
      assert.deepEqual(validated, { ok: false, reason: expected.invalid }, ballot.name);
    }
  }
});

/* ------------------------------------------------------------------------------------------
 * The v23 document.
 * ---------------------------------------------------------------------------------------- */

/** A sealed Poll over the fake Gateway scenario: account A weighs 125 and approves options
 * 0 and 2 with a real round-1000 ciphertext. */
function sealedDocument(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tally_doc_version: TALLY_DOC_VERSION,
    consultation_id: DOC_BALLOTS.consultation_id,
    title: "A sealed fixture vote",
    kind: "Poll",
    options: ["Option 0", "Option 1", "Option 2"],
    snapshot_state_version: 1000000,
    vote_start: 1692800064,
    vote_end: VOTE_END,
    weight_rule: XRD_WEIGHT_RULE,
    weight_sources: { native_pools: { mode: "all" } },
    excluded_accounts: [],
    votes: [
      {
        account: ACCOUNT_A,
        selection: [0, 2],
        weight: "125",
        ciphertext: docBallot("valid_approval").ciphertext,
        intent_hash: "ab".repeat(32),
        timestamp: 1692806300,
      },
    ],
    totals: ["125", "0", "125"],
    total_weight: "125",
    abstain_weight: "0",
    voter_count: 1,
    quorum: "0",
    approval_threshold_pc: "50",
    min_affirmative_support: "0",
    min_unique_voters: 0,
    abstain_allowed: true,
    eligible_voting_power: "0",
    category: null,
    quorum_met: true,
    mas_met: null,
    seats: 0,
    final_seats: 0,
    parent_id: null,
    parent_candidate_index: null,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
    withdrawn_excluded: null,
    approve_weight: null,
    reject_weight: null,
    approved: null,
    sealed: {
      box: "component_rdx1sealedballotbox",
      box_package: "package_rdx1sealedballotbox",
      box_recognised: true,
      round: ROUND,
      round_time: ROUND_TIME,
      round_margin_seconds: MARGIN,
      chain_hash: QUICKNET_CHAIN.chainHash,
      public_key: QUICKNET_CHAIN.publicKey,
      signature: SIGNATURE,
      max_selections: 3,
      abstain_allowed: true,
      majority_judgment: false,
      candidate_count: 0,
      option_count: 3,
    },
    late_ballots: [],
    ...over,
  };
}

const firstVote = (doc: Record<string, unknown>): Record<string, unknown> =>
  (doc["votes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;

test("a published selection that differs is refused", async () => {
  const doc = sealedDocument();
  // The ciphertext opens to 0,2. Publishing 0 alone is a claim the ballot does not support.
  firstVote(doc)["selection"] = [0];
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd");
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const difference = outcome.differences.find((d) => d.field.startsWith("votes[0].selection"));
  assert.ok(difference !== undefined, JSON.stringify(outcome.differences));
  assert.equal(difference.recomputed, "[0,2]");
});

test("a published invalid reason that differs is refused", async () => {
  const doc = sealedDocument();
  // 2,0 breaks cast_vote's strictly-increasing rule; publishing no reason claims it counted.
  const vote = firstVote(doc);
  vote["ciphertext"] = docBallot("not_increasing").ciphertext;
  vote["selection"] = [2, 0];
  const outcome = await verifyTallyDocument(doc, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd");
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const difference = outcome.differences.find((d) => d.field.startsWith("votes[0].sealed_invalid"));
  assert.ok(difference !== undefined, JSON.stringify(outcome.differences));
  assert.match(difference.recomputed, /invalid_selection/);
});

test("late ballots replace nothing", async () => {
  // Honest form: the timely ballot counts and the account's later ballot is reported late.
  const honest = sealedDocument({
    late_ballots: [
      {
        account: ACCOUNT_A,
        intent_hash: "cd".repeat(32),
        timestamp: ROUND_TIME,
        ciphertext: docBallot("valid_approval").ciphertext,
      },
    ],
  });
  assert.deepEqual(
    await verifyTallyDocument(honest, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"),
    { kind: "match", hashChecked: false },
  );

  // The lie: the LATE ballot at round_time is published as the vote, replacing the timely one.
  const replaced = sealedDocument();
  firstVote(replaced)["timestamp"] = ROUND_TIME;
  const outcome = await verifyTallyDocument(replaced, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd");
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const difference = outcome.differences.find((d) => d.field.startsWith("votes[0].timestamp"));
  assert.ok(difference !== undefined, JSON.stringify(outcome.differences));
  assert.match(difference.recomputed, /before round_time/);
});

test("a v22 document still verifies", async () => {
  const doc = {
    tally_doc_version: 22,
    consultation_id: "open-v22",
    kind: "Poll",
    options: ["Reject", "Approve"],
    snapshot_state_version: 1000000,
    weight_rule: XRD_WEIGHT_RULE_V22,
    weight_sources: { native_pools: { mode: "all" } },
    excluded_accounts: [],
    votes: [],
    totals: ["0", "0"],
    total_weight: "0",
    abstain_weight: "0",
    voter_count: 0,
    quorum: "0",
    approval_threshold_pc: "50",
    min_affirmative_support: "0",
    min_unique_voters: 0,
    abstain_allowed: true,
    quorum_met: true,
    mas_met: null,
    seats: 0,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
    withdrawn_excluded: null,
    approve_weight: null,
    reject_weight: null,
    approved: null,
  };
  assert.deepEqual(
    await verifyTallyDocument(doc, tallyHash(doc as unknown as Json), new FakeGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"),
    { kind: "match", hashChecked: true },
  );
});

test("the empty v23 document verifies", async () => {
  // The reference engine's own output for a sealed vote nobody cast in, with its hash.
  const file = load("engine/empty.json");
  const doc = file["document"] as Record<string, unknown>;
  assert.equal(doc["tally_doc_version"], 23);
  assert.deepEqual(doc["votes"], []);
  assert.deepEqual(
    await verifyTallyDocument(file, null, new FakeGateway(), STOKENET_XRD),
    { kind: "match", hashChecked: true },
  );
});

test("an invalid sealed ballot counts toward nothing", async () => {
  // 2,0 is invalid_selection. The ballot is still rendered and weighed, but reaches no option,
  // no total_weight and no voter_count — the document's empty tally is the honest one.
  const doc = sealedDocument({
    votes: [
      {
        account: ACCOUNT_A,
        selection: [],
        weight: "125",
        ciphertext: docBallot("not_increasing").ciphertext,
        intent_hash: "ef".repeat(32),
        timestamp: 1692806300,
        sealed_invalid: "invalid_selection",
      },
    ],
    totals: ["0", "0", "0"],
    total_weight: "0",
    voter_count: 0,
    quorum_met: true,
  });
  assert.deepEqual(
    await verifyTallyDocument(doc, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"),
    { kind: "match", hashChecked: false },
  );
});

test("a vote sealed to an unrecognised box counts nothing", async () => {
  // The engine's document for a box whose package the module does not record: every field after
  // `box_recognised` is null, no ballot is listed and the tally is empty. Nothing is opened and
  // no Gateway read is made.
  const file = load("engine/unrecognised.json");
  const doc = file["document"] as Record<string, unknown>;
  const sealed = doc["sealed"] as Record<string, unknown>;
  assert.equal(sealed["box_recognised"], false);
  for (const key of [
    "round",
    "round_time",
    "round_margin_seconds",
    "chain_hash",
    "public_key",
    "signature",
    "max_selections",
    "abstain_allowed",
    "majority_judgment",
    "candidate_count",
    "option_count",
  ]) {
    assert.equal(sealed[key], null, key);
  }
  const gw = new FakeGateway();
  assert.deepEqual(await verifyTallyDocument(file, null, gw, STOKENET_XRD), {
    kind: "match",
    hashChecked: true,
  });
  assert.deepEqual(gw.calls, []);

  // A round or a rule beside `box_recognised: false` is a block the engine never writes.
  for (const [key, value] of [
    ["chain_hash", QUICKNET_CHAIN.chainHash],
    ["round_margin_seconds", 30],
    ["max_selections", 3],
  ] as const) {
    const withField = structuredClone(doc);
    (withField["sealed"] as Record<string, unknown>)[key] = value;
    const outcome = await verifyTallyDocument(withField, null, new FakeGateway(), STOKENET_XRD);
    assert.equal(outcome.kind, "malformed", key);
  }

  // The contradiction the verifier can see without the registry: a counted ballot beside
  // `box_recognised: false`.
  const contradiction = sealedDocument({ sealed });
  const outcome = await verifyTallyDocument(contradiction, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd");
  assert.equal(outcome.kind, "figures");
});

test("reread compares the box's events with votes and late_ballots", async () => {
  const { doc } = parseTallyDocument(
    sealedDocument({
      late_ballots: [
        {
          account: ACCOUNT_A,
          intent_hash: "cd".repeat(32),
          timestamp: ROUND_TIME,
          ciphertext: docBallot("valid_approval").ciphertext,
        },
      ],
    }),
  );
  const vote = doc.votes[0] as (typeof doc.votes)[number];
  const events: SealedBallotEvent[] = [
    {
      stateVersion: 10,
      consultationId: doc.consultationId,
      intentHash: vote.intentHash,
      account: vote.account,
      ciphertext: vote.ciphertext as string,
      round: ROUND,
      roundTime: ROUND_TIME,
      timestamp: vote.timestamp as number,
    },
    {
      stateVersion: 11,
      consultationId: doc.consultationId,
      intentHash: "cd".repeat(32),
      account: ACCOUNT_A,
      ciphertext: docBallot("valid_approval").ciphertext,
      round: ROUND,
      roundTime: ROUND_TIME,
      timestamp: ROUND_TIME,
    },
  ];
  assert.deepEqual(compareSealedBallotEvents(events, doc), []);

  // A superseded timely ballot need not appear in `votes`: only the latest one counts.
  const superseded: SealedBallotEvent = {
    ...(events[0] as SealedBallotEvent),
    stateVersion: 9,
    ciphertext: "superseded",
    timestamp: 1692806200,
  };
  assert.deepEqual(compareSealedBallotEvents([superseded, ...events], doc), []);

  // But a ledger ballot the document does not publish is the signal.
  const tampered = events.map((e) =>
    e.stateVersion === 10 ? { ...e, ciphertext: "not-the-published-ciphertext" } : e,
  );
  const differences = compareSealedBallotEvents(tampered, doc);
  assert.ok(differences.some((d) => d.field.startsWith("votes (")), JSON.stringify(differences));
});

test("a v23 document parses its sealed block and per-vote fields", () => {
  const { doc } = parseTallyDocument(sealedDocument());
  assert.equal(doc.tallyDocVersion, 23);
  assert.ok(doc.sealed !== null);
  assert.equal(doc.sealed.round, ROUND);
  assert.equal(doc.sealed.roundTime, ROUND_TIME);
  assert.equal(doc.sealed.boxRecognised, true);
  assert.deepEqual(doc.lateBallots, []);
  assert.equal(doc.votes[0]?.ciphertext, docBallot("valid_approval").ciphertext);
  assert.equal(doc.votes[0]?.timestamp, 1692806300);
  assert.equal(doc.votes[0]?.sealedInvalid, null);
  // An open document carries no sealed block and no per-vote ciphertext fields.
  const open = parseTallyDocument({
    ...sealedDocument(),
    sealed: undefined,
    late_ballots: undefined,
  }).doc;
  assert.equal(open.sealed, null);
  assert.equal(open.lateBallots, null);
});

/* ------------------------------------------------------------------------------------------
 * The reference engine's own v23 documents (OTER `feat/sealed-box` 3b9e9fc5, dumped from
 * `sealed_tally_tests.rs` with their `document_hash_blake2b`). Every account there holds 100 XRD
 * and nothing else at the snapshot, which `engineGateway` answers.
 * ---------------------------------------------------------------------------------------- */

const ENGINE_DOCUMENTS = [
  "empty",
  "valid_approval",
  "abstention",
  "invalid_per_reason",
  "late",
  "over_cap",
  "delegator_revoked",
  "delegated_to_invalid",
  "unrecognised",
] as const;

type EngineFile = { document: Record<string, unknown>; document_hash_blake2b: string };

const engineFile = (name: (typeof ENGINE_DOCUMENTS)[number]): EngineFile =>
  load(`engine/${name}.json`) as unknown as EngineFile;

/** The weights the engine's stand-in Gateway gave: 100 XRD for every account it weighed (every
 * voter and every delegator), at the document's snapshot, and no validators. */
function engineGateway(doc: Record<string, unknown>): FakeGateway {
  const votes = doc["votes"] as Array<{ account: string }>;
  const delegations = (doc["delegations"] ?? []) as Array<{ delegator: string }>;
  const accounts = [...new Set([...votes.map((v) => v.account), ...delegations.map((d) => d.delegator)])];
  if (accounts.length === 0) return new FakeGateway();
  return new FakeGateway()
    .onDetails({
      ledger_state: { state_version: doc["snapshot_state_version"] },
      items: accounts.map((address) => ({
        address,
        fungible_resources: {
          total_count: 1,
          next_cursor: null,
          items: [{ resource_address: STOKENET_XRD, amount: "100" }],
        },
      })),
    })
    .onValidators({ items: [], next_cursor: null });
}

async function verifyEngine(doc: Record<string, unknown>, hash: string | null) {
  return verifyTallyDocument(doc, hash, engineGateway(doc), STOKENET_XRD);
}

/** The differences a tampered engine document is reported with (its hash no longer applies). */
async function differencesOf(doc: Record<string, unknown>): Promise<Array<{ field: string; document: string; recomputed: string }>> {
  const outcome = await verifyEngine(doc, null);
  assert.equal(outcome.kind, "figures", JSON.stringify(outcome));
  return outcome.kind === "figures" ? outcome.differences : [];
}

test("every engine v23 document verifies with its hash", async () => {
  for (const name of ENGINE_DOCUMENTS) {
    const file = engineFile(name);
    assert.equal(file.document["tally_doc_version"], 23, name);
    assert.deepEqual(
      await verifyEngine(file.document, file.document_hash_blake2b),
      { kind: "match", hashChecked: true },
      name,
    );
  }
});

test("the v23 weight rule is the engine's text, checked for equality", async () => {
  for (const name of ENGINE_DOCUMENTS) {
    assert.equal(engineFile(name).document["weight_rule"], weightRuleText({ kind: "Xrd" }, 23), name);
  }
  assert.equal(XRD_WEIGHT_RULE, XRD_WEIGHT_RULE_V22 + SEALED_WEIGHT_RULE_SENTENCES);
  assert.ok(SEALED_WEIGHT_RULE_SENTENCES.startsWith(" Sealed votes: "));
  // The two space rules did not change in v23.
  const resource = "resource_tdx_2_1token";
  assert.equal(weightRuleText({ kind: "Fungible", resource }, 23), weightRuleText({ kind: "Fungible", resource }, 22));
  assert.equal(weightRuleText({ kind: "Membership", resource }, 23), weightRuleText({ kind: "Membership", resource }, 22));

  // A v23 document that states the v22 text, or the v23 text with one word changed, is refused.
  for (const rule of [XRD_WEIGHT_RULE_V22, XRD_WEIGHT_RULE.replace("replaces nothing", "replaces the timely one")]) {
    const doc = structuredClone(engineFile("valid_approval").document);
    doc["weight_rule"] = rule;
    const differences = await differencesOf(doc);
    assert.ok(differences.some((d) => d.field === "weight_rule"), JSON.stringify(differences));
  }
});

test("max_selections is enforced on a sealed ballot", async () => {
  // The engine's document: a Poll capped at one selection, and a ballot that opens to 0,2. The
  // ballot is invalid only for the cap; every other rule holds.
  const file = engineFile("over_cap");
  const sealed = file.document["sealed"] as Record<string, unknown>;
  assert.equal(sealed["max_selections"], 1);
  assert.equal(sealed["option_count"], 3);
  const vote = (file.document["votes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(vote["sealed_invalid"], "invalid_selection");
  assert.deepEqual(vote["selection"], []);

  // Publishing that ballot as counted is refused: the cap the block states rules it out.
  const counted = structuredClone(file.document);
  const countedVote = (counted["votes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  delete countedVote["sealed_invalid"];
  countedVote["selection"] = [0, 2];
  counted["totals"] = ["100", "0", "100"];
  counted["total_weight"] = "100";
  counted["voter_count"] = 1;
  const differences = await differencesOf(counted);
  const reason = differences.find((d) => d.field.startsWith("votes[0].sealed_invalid"));
  assert.ok(reason !== undefined, JSON.stringify(differences));
  assert.equal(reason.document, "valid");
  assert.equal(reason.recomputed, "invalid_selection");

  // The same ballot under a cap of three counts.
  const { doc } = parseTallyDocument(sealedDocument());
  assert.equal(doc.sealed?.rules?.maxSelections, 3);
});

test("the block's selection rules are held to the rest of the document", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["abstain_allowed", false, "sealed.abstain_allowed"],
    ["majority_judgment", true, "sealed.majority_judgment"],
    ["option_count", 4, "sealed.option_count"],
  ];
  for (const [key, value, field] of cases) {
    const doc = structuredClone(engineFile("valid_approval").document);
    (doc["sealed"] as Record<string, unknown>)[key] = value;
    const differences = await differencesOf(doc);
    assert.ok(differences.some((d) => d.field === field), `${key}: ${JSON.stringify(differences)}`);
  }
});

test("a plaintext that is not UTF-8 is malformed", async () => {
  const fixture = load("non_utf8.json") as { ciphertext: string; plaintext_hex: string };
  assert.ok(Buffer.from(fixture.plaintext_hex, "hex").includes(0xff));
  assert.deepEqual(await openBallot(fixture.ciphertext, chain(), ROUND, SIGNATURE), {
    ok: false,
    reason: "malformed",
  });

  // In a document: published as malformed with no selection, it counts toward nothing.
  const vote = {
    account: ACCOUNT_A,
    selection: [],
    weight: "125",
    ciphertext: fixture.ciphertext,
    intent_hash: "aa".repeat(32),
    timestamp: 1692806300,
    sealed_invalid: "malformed",
  };
  const honest = sealedDocument({
    votes: [vote],
    totals: ["0", "0", "0"],
    total_weight: "0",
    voter_count: 0,
  });
  assert.deepEqual(
    await verifyTallyDocument(honest, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"),
    { kind: "match", hashChecked: false },
  );
  const asUndecryptable = sealedDocument({
    votes: [{ ...vote, sealed_invalid: "undecryptable" }],
    totals: ["0", "0", "0"],
    total_weight: "0",
    voter_count: 0,
  });
  const outcome = await verifyTallyDocument(asUndecryptable, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd");
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const difference = outcome.differences.find((d) => d.field.startsWith("votes[0].sealed_invalid"));
  assert.ok(difference !== undefined, JSON.stringify(outcome.differences));
  assert.equal(difference.recomputed, "malformed");
});

test("an invalid sealed ballot is judged by its reason token and publishes no selection", async () => {
  // The engine's document: one ballot per reason, each with `selection: []`.
  const file = engineFile("invalid_per_reason");
  const votes = file.document["votes"] as Array<Record<string, unknown>>;
  assert.deepEqual(
    votes.map((v) => v["sealed_invalid"]),
    ["undecryptable", "wrong_round", "malformed", "wrong_vote", "invalid_selection"],
  );
  for (const v of votes) assert.deepEqual(v["selection"], []);

  // The wrong_vote ballot opens to a valid selection for another account. It is not compared:
  // the token is. A non-empty selection on an invalid ballot is not the engine's rendering.
  const withSelection = structuredClone(file.document);
  ((withSelection["votes"] as Array<Record<string, unknown>>)[3] as Record<string, unknown>)["selection"] = [0, 2];
  const selectionDiffs = await differencesOf(withSelection);
  assert.ok(selectionDiffs.some((d) => d.field.startsWith("votes[3].selection")), JSON.stringify(selectionDiffs));
  assert.ok(!selectionDiffs.some((d) => d.field.startsWith("votes[3].sealed_invalid")), JSON.stringify(selectionDiffs));

  // Another token on the same ballot is refused.
  const otherToken = structuredClone(file.document);
  ((otherToken["votes"] as Array<Record<string, unknown>>)[3] as Record<string, unknown>)["sealed_invalid"] = "malformed";
  const tokenDiffs = await differencesOf(otherToken);
  const token = tokenDiffs.find((d) => d.field.startsWith("votes[3].sealed_invalid"));
  assert.ok(token !== undefined, JSON.stringify(tokenDiffs));
  assert.equal(token.recomputed, "wrong_vote");
});

test("weight delegated to an invalid sealed ballot is in delegated_weight_total", async () => {
  // Mirrors the engine: `delegated_weight_by_delegate` (tally_engine.rs) sums every counted
  // delegation whatever happens to the delegate's ballot, and an invalid sealed ballot is a
  // ballot for delegation (its account is in `voted`). So the delegator's 100 is counted as
  // delegated and rides the invalid ballot (delegated_weight 100, effective_weight 200), and is
  // lost with it: total_weight stays 0. `deriveFigures` resolves the delegations before its
  // `sealedInvalid` skip, with the same `voted` set, which is what makes the two agree.
  const file = engineFile("delegated_to_invalid");
  const doc = file.document;
  assert.equal(doc["delegated_weight_total"], "100");
  assert.equal(doc["total_weight"], "0");
  assert.equal(doc["voter_count"], 0);
  const vote = (doc["votes"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(vote["sealed_invalid"], "invalid_selection");
  assert.equal(vote["delegated_weight"], "100");
  assert.equal(vote["effective_weight"], "200");
  const delegation = (doc["delegations"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(delegation["counted"], true);

  const tampered = structuredClone(doc);
  tampered["delegated_weight_total"] = "0";
  const differences = await differencesOf(tampered);
  const total = differences.find((d) => d.field === "delegated_weight_total");
  assert.ok(total !== undefined, JSON.stringify(differences));
  assert.equal(total.recomputed, "100");

  // And the other direction: an invalid ballot by the DELEGATOR revokes its delegation.
  const revoked = engineFile("delegator_revoked").document;
  assert.equal(revoked["delegated_weight_total"], "0");
});
