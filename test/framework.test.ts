import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Dec } from "../src/decimal.ts";
import { decisionSides, frameworkFor } from "../src/framework.ts";

test("GP/0's constitutional bar derives eligible 13508325920 and MAS 472791407.2", () => {
  const f = frameworkFor("proposal", "dao-constitutional", Dec.parse("1350832592"));
  assert.ok(f !== null);
  assert.equal(f.eligible.toString(), "13508325920");
  assert.equal(f.mas.toString(), "472791407.2");
  assert.equal(f.bound.toString(), "10");
  assert.equal(f.minUniqueVoters, 0);
});

test("the live quorums derive within 100/pc below the true eligible figure", () => {
  const truth = Dec.parse("13508325920");
  for (const [kind, set, quorum] of [
    ["proposal", "default", "675416296"],
    ["proposal", "dao-constitutional", "1350832592"],
    ["proposal", "dao-governance", "945582814"],
    ["proposal", "dao-treasury", "945582814"],
    ["temperature_check", "dao-constitutional", "405249777"],
  ] as const) {
    const f = frameworkFor(kind, set, Dec.parse(quorum));
    assert.ok(f !== null);
    assert.ok(f.eligible.lte(truth) && f.eligible.gte(truth.sub_(f.bound)), `${set}: ${f.eligible}`);
  }
});

test("a temperature check is 3 % with no MAS under every set; an unknown proposal set decides nothing", () => {
  const tc = frameworkFor("temperature_check", "no-such-set", Dec.parse("300"));
  assert.ok(tc !== null);
  assert.equal(tc.quorumPc.toString(), "3");
  assert.equal(tc.mas.toString(), "0");
  assert.equal(frameworkFor("proposal", "dao-future", Dec.parse("100")), null);
  assert.equal(frameworkFor("proposal", "dao-election", Dec.parse("100")), null);
  assert.equal(frameworkFor("proposal", null, Dec.parse("100")), null);
  assert.equal(frameworkFor("proposal", "dao-treasury", Dec.parse("945582814"))?.minUniqueVoters, 50);
});

test("a Majority Judgment round uses the dao-election row: 7 %, no MAS, no voter floor", () => {
  const f = frameworkFor("majority_judgment_election", "dao-election", Dec.parse("100"));
  assert.ok(f !== null);
  assert.equal(f.quorumPc.toString(), "7");
  assert.equal(f.masPc.toString(), "0");
  assert.equal(f.mas.toString(), "0");
  assert.equal(f.minUniqueVoters, 0);
  assert.equal(f.eligible.toString(), "1428.571428571428571428");
  assert.equal(f.bound.toString(), "14.285714285714285714");
  assert.deepEqual(
    frameworkFor("majority_judgment_election_rerun", "dao-election", Dec.parse("100")),
    f,
  );
  // The election row is not a proposal row, and a round under any other set gets no bar.
  assert.equal(frameworkFor("proposal", "dao-election", Dec.parse("100")), null);
  assert.equal(frameworkFor("majority_judgment_election", "default", Dec.parse("100")), null);
});

test("sides come from the labels, never the positions", () => {
  assert.deepEqual(decisionSides("temperature_check", [], null), { approve: 1, reject: 0, abstain: null });
  assert.deepEqual(decisionSides("proposal", ["Reject", "Abstain", "Approve"], null), { approve: 2, reject: 0, abstain: 1 });
  assert.deepEqual(decisionSides("proposal", [" APPROVE ", "reject"], null), { approve: 0, reject: 1, abstain: null });
  for (const set of [["Yes", "No"], ["Approve", "Reject", "Abstain", "Other"], ["Approve", "Approve", "Reject"], ["Approve", "Abstain"]]) {
    assert.equal(decisionSides("proposal", set, null), null, JSON.stringify(set));
  }
  assert.equal(decisionSides("proposal", ["Approve", "Reject", "Abstain"], 2), null, "multi-select");
});

/**
 * "Trimmed" means ASCII whitespace only — U+0020, U+0009, U+000A, U+000C, U+000D — so the
 * verifier and any other implementation agree on every label. A label wrapped in anything else
 * is not Approve/Reject/Abstain and the proposal decides nothing. U+FEFF is the case JavaScript's
 * `trim()` would strip; U+0085 the case Rust's `str::trim` would; U+000B is outside the set too.
 */
test("labels are trimmed of ASCII whitespace only", () => {
  assert.deepEqual(
    decisionSides("proposal", [" \t\nApprove\r\f ", "  Reject\n", "\tAbstain "], null),
    { approve: 0, reject: 1, abstain: 2 },
  );
  for (const other of ["﻿", "\u0085", "\u000B", " ", " "]) {
    const code = other.codePointAt(0)?.toString(16);
    assert.equal(decisionSides("proposal", [`${other}Approve`, "Reject"], null), null, `leading U+${code}`);
    assert.equal(decisionSides("proposal", ["Approve", `Reject${other}`], null), null, `trailing U+${code}`);
  }
});
