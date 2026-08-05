/**
 * Weight recomputation against fixture Gateway responses — no network anywhere near these
 * tests. The fixture scenario, and the arithmetic it pins:
 *
 *   account A: 100 XRD, 50 LSU of a validator with 1000 XRD staked against a 2000 LSU supply
 *              -> 100 + 50 * 1000 / 2000 = 125
 *   account B: 10 units of a pool whose backing is 500 XRD + 40 LSU (worth 20 by the same
 *              conversion) against a 100 unit supply -> 10 * 520 / 100 = 52
 *              plus 999999 of a token that CLAIMS the same pool — rejected, because the pool
 *              names its own unit back, not the impostor — and some dust that matches no rule
 *
 * Account B's holdings arrive over two pages, because the long tail off page one is exactly
 * where a truncated walk would lose a voter's stake.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Dec } from "../src/decimal.ts";
import { computeAccountWeights, verifiedPoolUnits } from "../src/weights.ts";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  IMPOSTOR,
  POOL,
  POOL_UNIT,
  SNAPSHOT_SV,
  XRD,
  scenarioGateway,
} from "./fake-gateway.ts";

const ALL_POOLS = { native_pools: { mode: "all" as const } };

test("weights are XRD plus LSUs at the redemption rate plus verified pool-unit shares", async () => {
  const weights = await computeAccountWeights(
    scenarioGateway(),
    [ACCOUNT_A, ACCOUNT_B],
    SNAPSHOT_SV,
    ALL_POOLS,
    XRD,
  );
  assert.equal(weights.get(ACCOUNT_A)?.toString(), "125");
  assert.equal(weights.get(ACCOUNT_B)?.toString(), "52");
});

test("a token claiming someone else's pool inherits none of its backing", async () => {
  // B holds 999999 of the impostor. If the forward claim alone were believed, B's weight
  // would be 52 + 999999 * 520 / 100 — the pool's entire backing, many times over. The round
  // trip is the only thing between that and a bought election.
  const weights = await computeAccountWeights(
    scenarioGateway(),
    [ACCOUNT_B],
    SNAPSHOT_SV,
    ALL_POOLS,
    XRD,
  );
  assert.equal(weights.get(ACCOUNT_B)?.toString(), "52");
});

test("the register gates a genuine pool unit: off counts none, an allowlist only its own", async () => {
  const off = await computeAccountWeights(
    scenarioGateway(),
    [ACCOUNT_B],
    SNAPSHOT_SV,
    { native_pools: { mode: "off" } },
    XRD,
  );
  assert.equal(off.get(ACCOUNT_B)?.toString(), "0", "off: the pool unit contributes nothing");

  const otherPool = "pool_rdx1other00000000000000000000000000000000000000000000009";
  const notListed = await computeAccountWeights(
    scenarioGateway(),
    [ACCOUNT_B],
    SNAPSHOT_SV,
    { native_pools: { mode: "allowlist", pools: [otherPool] } },
    XRD,
  );
  assert.equal(notListed.get(ACCOUNT_B)?.toString(), "0", "a genuine pool absent from the register must not count");

  const listed = await computeAccountWeights(
    scenarioGateway(),
    [ACCOUNT_B],
    SNAPSHOT_SV,
    { native_pools: { mode: "allowlist", pools: [POOL] } },
    XRD,
  );
  assert.equal(listed.get(ACCOUNT_B)?.toString(), "52", "a genuine pool named by the register counts");
});

test("verifiedPoolUnits requires both directions of the link", () => {
  const held = new Map([
    [POOL_UNIT, { totalSupply: Dec.fromInt(100n), pool: POOL }],
    [IMPOSTOR, { totalSupply: Dec.fromInt(999999n), pool: POOL }],
  ]);
  const declared = new Map([[POOL, POOL_UNIT]]);
  const verified = verifiedPoolUnits(held, declared, { mode: "all" });
  assert.equal(verified.get(POOL_UNIT), POOL);
  assert.equal(verified.has(IMPOSTOR), false, "the pool names its own unit, not the impostor");

  // A component outside the native pool address space cannot confirm anything, even when it
  // answers pool_unit correctly — only the engine's pool blueprints allocate pool_ addresses.
  const fakePool = "component_rdx1fake000000000000000000000000000000000000000000006";
  const spoofed = verifiedPoolUnits(
    new Map([[IMPOSTOR, { totalSupply: Dec.fromInt(1n), pool: fakePool }]]),
    new Map([[fakePool, IMPOSTOR]]),
    { mode: "all" },
  );
  assert.equal(spoofed.size, 0);
});

test("an allowlist entry is not a bypass: a spoofed unit of a listed pool still fails", () => {
  const held = new Map([[IMPOSTOR, { totalSupply: Dec.fromInt(1n), pool: POOL }]]);
  const declared = new Map([[POOL, POOL_UNIT]]);
  const verified = verifiedPoolUnits(held, declared, { mode: "allowlist", pools: [POOL] });
  assert.equal(verified.size, 0);
});

test("an unknown account weighs zero rather than failing the tally", async () => {
  const weights = await computeAccountWeights(
    scenarioGateway(),
    [ACCOUNT_A, ACCOUNT_B, "account_rdx1nobody"],
    SNAPSHOT_SV,
    ALL_POOLS,
    XRD,
  );
  assert.equal(weights.get("account_rdx1nobody")?.toString(), "0");
});
