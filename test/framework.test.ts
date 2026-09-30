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

test("sides come from the labels, never the positions", () => {
  assert.deepEqual(decisionSides("temperature_check", [], null), { approve: 1, reject: 0, abstain: null });
  assert.deepEqual(decisionSides("proposal", ["Reject", "Abstain", "Approve"], null), { approve: 2, reject: 0, abstain: 1 });
  assert.deepEqual(decisionSides("proposal", [" APPROVE ", "reject"], null), { approve: 0, reject: 1, abstain: null });
  for (const set of [["Yes", "No"], ["Approve", "Reject", "Abstain", "Other"], ["Approve", "Approve", "Reject"], ["Approve", "Abstain"]]) {
    assert.equal(decisionSides("proposal", set, null), null, JSON.stringify(set));
  }
  assert.equal(decisionSides("proposal", ["Approve", "Reject", "Abstain"], 2), null, "multi-select");
});
