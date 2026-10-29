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
import { XRD_WEIGHT_RULE } from "../src/weight-rule.ts";

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
    weight_rule: XRD_WEIGHT_RULE,
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
  // The shape Task 9's `a_sealed_vote_with_no_ballots_yields_an_empty_v23_document`
  // publishes: the sealed block, no votes, and an empty tally. The fixture is built from
  // spec 6.6 because that test was written in parallel; no Gateway read is needed for it.
  const doc = load("empty_v23.json");
  assert.equal(doc["tally_doc_version"], 23);
  assert.deepEqual(
    await verifyTallyDocument(doc, null, new FakeGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"),
    { kind: "match", hashChecked: false },
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
  const unrecognised = sealedDocument({
    votes: [],
    totals: ["0", "0", "0"],
    total_weight: "0",
    voter_count: 0,
    sealed: {
      box: "component_rdx1lookalike",
      box_package: "package_rdx1lookalike",
      box_recognised: false,
      round: null,
      round_time: null,
      round_margin_seconds: 300,
      chain_hash: QUICKNET_CHAIN.chainHash,
      public_key: QUICKNET_CHAIN.publicKey,
      signature: null,
    },
  });
  assert.deepEqual(
    await verifyTallyDocument(unrecognised, null, scenarioGateway(), "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"),
    { kind: "match", hashChecked: false },
  );

  // The contradiction the verifier can see without the registry: a counted ballot beside
  // `box_recognised: false`.
  const contradiction = sealedDocument({
    sealed: {
      box: "component_rdx1lookalike",
      box_package: "package_rdx1lookalike",
      box_recognised: false,
      round: null,
      round_time: null,
      round_margin_seconds: 300,
      chain_hash: QUICKNET_CHAIN.chainHash,
      public_key: QUICKNET_CHAIN.publicKey,
      signature: null,
    },
  });
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
