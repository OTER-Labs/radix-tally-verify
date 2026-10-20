/**
 * Structural consistency the document can be checked against without a registry read: the
 * `weight_rule` text its own `weight_config` implies, the register that config implies, and —
 * when the caller supplies the registry's sets — the versions and embedded lists they name.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { verifyTallyDocument } from "../src/verify.ts";
import { spaceRegisterProblem, weightRuleText, weightSourcesForSpace } from "../src/weight-rule.ts";

import { ACCOUNT_A, ACCOUNT_B, scenarioGateway, XRD } from "./fake-gateway.ts";

const hash = (doc: Record<string, unknown>): string => tallyHash(doc as unknown as Json);

function v22Doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tally_doc_version: 22,
    consultation_id: "c-consistency",
    kind: "Binding",
    options: ["Reject", "Approve"],
    snapshot_state_version: 1000000,
    excluded_accounts: [],
    weight_sources: { native_pools: { mode: "all" } },
    weight_rule: weightRuleText({ kind: "Xrd" }),
    weight_set_version: 6,
    excluded_set_version: 3,
    votes: [
      { account: ACCOUNT_A, selection: [1], weight: "125" },
      { account: ACCOUNT_B, selection: [1], weight: "52" },
    ],
    totals: ["0", "177"],
    total_weight: "177",
    abstain_weight: "0",
    voter_count: 2,
    quorum: "100",
    approval_threshold_pc: "50",
    min_affirmative_support: "10",
    min_unique_voters: 2,
    quorum_met: true,
    mas_met: true,
    seats: 0,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
    withdrawn_excluded: null,
    approve_weight: "177",
    reject_weight: "0",
    approved: true,
    ...over,
  };
}

test("weight_rule must be the text the document's weight_config implies", async () => {
  const doc = v22Doc({ weight_rule: "weight(account) = whatever the publisher liked" });
  const outcome = await verifyTallyDocument(doc, hash(doc), scenarioGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind === "figures") {
    assert.deepEqual(
      outcome.differences.find((d) => d.field === "weight_rule"),
      {
        field: "weight_rule",
        document: "weight(account) = whatever the publisher liked",
        recomputed: weightRuleText({ kind: "Xrd" }),
      },
    );
  }
});

test("a Fungible document may not carry an XRD-priced register or a different resource", () => {
  const config = { kind: "Fungible" as const, resource: "resource_rdx1token" };
  assert.equal(
    spaceRegisterProblem(config, { native_pools: { mode: "all" }, fungible: { resource: config.resource } }),
    "carries a native_pools leg that is not off",
  );
  assert.equal(
    spaceRegisterProblem(config, { native_pools: { mode: "off" }, membership: { resource: config.resource } }),
    "carries a membership leg under a Fungible weight_config",
  );
  assert.equal(
    spaceRegisterProblem(config, {
      native_pools: { mode: "off" },
      fungible: { resource: "resource_rdx1other" },
    }),
    "names resource_rdx1other in weight_sources.fungible, not resource_rdx1token",
  );
  assert.equal(
    spaceRegisterProblem(config, { native_pools: { mode: "off" }, fungible: { resource: config.resource } }),
    null,
  );
});

test("weightSourcesForSpace replaces the valuation legs and keeps delegation", () => {
  const registered = {
    native_pools: { mode: "all" as const },
    lsulp: { mode: "component" as const, component: "component_rdx1lp", resource: "resource_rdx1lp" },
    delegation: { mode: "component" as const, component: "component_rdx1dl" },
  };
  assert.deepEqual(weightSourcesForSpace({ kind: "Xrd" }, registered), registered);
  assert.deepEqual(weightSourcesForSpace({ kind: "Fungible", resource: "resource_rdx1t" }, registered), {
    native_pools: { mode: "off" },
    delegation: { mode: "component", component: "component_rdx1dl" },
    fungible: { resource: "resource_rdx1t" },
  });
  assert.deepEqual(weightSourcesForSpace({ kind: "Membership", resource: "resource_rdx1n" }, registered), {
    native_pools: { mode: "off" },
    delegation: { mode: "component", component: "component_rdx1dl" },
    membership: { resource: "resource_rdx1n" },
  });
});

test("a supplied weight set checks weight_set_version and the register it names", async () => {
  const wrongVersion = await verifyTallyDocument(v22Doc(), null, scenarioGateway(), XRD, {
    weightSet: { network: "mainnet", version: 7, sources: { native_pools: { mode: "all" } } },
  });
  assert.equal(wrongVersion.kind, "figures");
  if (wrongVersion.kind === "figures") {
    assert.deepEqual(
      wrongVersion.differences.find((d) => d.field === "weight_set_version"),
      { field: "weight_set_version", document: "6", recomputed: "7" },
    );
  }

  const matching = await verifyTallyDocument(v22Doc(), hash(v22Doc()), scenarioGateway(), XRD, {
    weightSet: { network: "mainnet", version: 6, sources: { native_pools: { mode: "all" } } },
  });
  assert.deepEqual(matching, { kind: "match", hashChecked: true });

  const wrongRegister = await verifyTallyDocument(v22Doc(), null, scenarioGateway(), XRD, {
    weightSet: { network: "mainnet", version: 6, sources: { native_pools: { mode: "off" } } },
  });
  assert.equal(wrongRegister.kind, "figures");
  if (wrongRegister.kind === "figures") {
    assert.ok(wrongRegister.differences.some((d) => d.field === "weight_sources"));
  }
});

test("a supplied excluded set checks excluded_set_version and the embedded list", async () => {
  const wrong = await verifyTallyDocument(v22Doc(), null, scenarioGateway(), XRD, {
    excludedSet: { version: 4, accounts: [] },
  });
  assert.equal(wrong.kind, "figures");
  if (wrong.kind === "figures") {
    assert.deepEqual(
      wrong.differences.find((d) => d.field === "excluded_set_version"),
      { field: "excluded_set_version", document: "3", recomputed: "4" },
    );
  }

  const wrongList = await verifyTallyDocument(v22Doc(), null, scenarioGateway(), XRD, {
    excludedSet: { version: 3, accounts: ["account_rdx1barred"] },
  });
  assert.equal(wrongList.kind, "figures");
  if (wrongList.kind === "figures") {
    assert.ok(wrongList.differences.some((d) => d.field === "excluded_accounts"));
  }

  const matching = await verifyTallyDocument(v22Doc(), hash(v22Doc()), scenarioGateway(), XRD, {
    excludedSet: { version: 3, accounts: [] },
  });
  assert.deepEqual(matching, { kind: "match", hashChecked: true });
});
