/**
 * The shipped official allowlists (`data/official-allowlist.*.json`, `src/allowlist.ts`).
 *
 * These files are DATA a verifier carries so that a mirror document's official leg can be
 * checked against a list the document did not supply. Everything worth asserting about them is
 * therefore about the data itself: it parses, it is the list the app publishes, it maps to the
 * four register legs, and its hash is the number the reference implementation independently
 * arrives at. That last one is the point of the whole package — two implementations, one
 * specification — so it is pinned here as a literal rather than recomputed from the same file
 * twice.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { allowlistHash, allowlistWeightSources, officialAllowlistFor } from "../src/allowlist.ts";
import type { OfficialAllowlistEntry } from "../src/allowlist.ts";

const MAINNET_COMPONENT = "component_rdx1czn9hrgd30x742k6jw2e6psj9jlkqvu2cj4hcry60p7f38hxd3k3xt";
const STOKENET_COMPONENT = "component_tdx_2_1cp0governance000000000000000000000000000000000007";

test("the mainnet list is the app's own sixty-eight positions plus the LSULP pair", () => {
  const a = officialAllowlistFor(MAINNET_COMPONENT);
  assert.equal(a.network, "mainnet");
  const count = (kind: string): number => a.entries.filter((e) => e.kind === kind).length;
  assert.equal(count("Lsulp"), 1);
  assert.equal(count("NativePool"), 39);
  assert.equal(count("PrecisionPool"), 14);
  assert.equal(count("ShapePool"), 15);
  assert.equal(a.entries.length, 69);

  // The DEX split the app's own page prints, counted rather than described.
  const perDex = new Map<string, number>();
  for (const e of a.entries) perDex.set(e.dex, (perDex.get(e.dex) ?? 0) + 1);
  assert.deepEqual(
    [...perDex].sort(([x], [y]) => (x < y ? -1 : 1)),
    [
      ["CaviarNine HLP", 1],
      ["CaviarNine LSU Pool", 1],
      ["CaviarNine Shape", 15],
      ["CaviarNine Simple", 11],
      ["DefiPlaza Base", 11],
      ["DefiPlaza Quote", 11],
      ["Ociswap Basic", 4],
      ["Ociswap Flex", 1],
      ["Ociswap V1", 4],
      ["Ociswap V2", 10],
    ],
  );

  // A duplicate position resource would double-count a holder's units.
  const resources = new Set(a.entries.map((e) => e.resource));
  assert.equal(resources.size, a.entries.length);
});

test("the mainnet list's hash is the one the reference implementation publishes", () => {
  const a = officialAllowlistFor(MAINNET_COMPONENT);
  assert.equal(a.version, "2026-09-06");
  assert.equal(a.hash, "bfadafb515c346c6f44b18f18a0ea71bd019523193ff49db7a8f6c53d704946f");
});

test("the mainnet list becomes a NAMED register, never discovery", () => {
  const a = officialAllowlistFor(MAINNET_COMPONENT);
  assert.equal(a.sources.native_pools.mode, "allowlist");
  if (a.sources.native_pools.mode === "allowlist") {
    assert.equal(a.sources.native_pools.pools.length, 39);
  }
  assert.equal(a.sources.lsulp?.mode, "component");
  assert.equal(a.sources.precision_pools?.mode, "allowlist");
  assert.equal(a.sources.shape_pools?.mode, "allowlist");
  // The official rule has no delegation leg and a mirror is never a Fungible or Membership space.
  assert.equal(a.sources.delegation, undefined);
  assert.equal(a.sources.fungible, undefined);
  assert.equal(a.sources.membership, undefined);
});

/**
 * An empty list has to mean COUNT NOTHING, never "count every pool you can find". This is the
 * difference between the official leg and the DAO's register on a test stack — the stack's
 * registry is instantiated with pool DISCOVERY on and no named entry — so getting it backwards
 * would make the two legs identical by accident and the mirror unable to state its own claim.
 */
test("the stokenet list names nothing, and that counts no pool at all", () => {
  const a = officialAllowlistFor(STOKENET_COMPONENT);
  assert.equal(a.network, "stokenet");
  assert.deepEqual(a.entries, []);
  assert.deepEqual(a.sources.native_pools, { mode: "off" });
  assert.equal(a.sources.lsulp, undefined);
  assert.equal(a.sources.precision_pools, undefined);
  assert.equal(a.sources.shape_pools, undefined);
  assert.equal(a.hash, "c2c013c86a9c92e22f966f3d8617768f8b7a44c902adcc097bfa1e098afb4e1f");
});

test("the component address picks the network, with no configuration anywhere", () => {
  assert.equal(officialAllowlistFor("component_rdx1anything").network, "mainnet");
  for (const stokenetish of ["component_tdx_2_1c", "component_sim1c", "", "component_rdx"]) {
    assert.equal(officialAllowlistFor(stokenetish).network, "stokenet", stokenetish);
  }
});

test("the hash is over entries alone, canonically, and ignores where the list came from", () => {
  const entries: OfficialAllowlistEntry[] = [
    {
      kind: "NativePool",
      dex: "Ociswap Basic",
      pair: "OCI/XRD",
      component: "pool_rdx1c",
      resource: "resource_rdx1t",
    },
  ];
  const digest = allowlistHash(entries);
  assert.match(digest, /^[0-9a-f]{64}$/);
  // Key order in the source object is not content: canonicalization sorts them.
  const reordered: OfficialAllowlistEntry[] = [
    {
      resource: "resource_rdx1t",
      pair: "OCI/XRD",
      component: "pool_rdx1c",
      dex: "Ociswap Basic",
      kind: "NativePool",
    },
  ];
  assert.equal(allowlistHash(reordered), digest);
  // A changed label IS content — a list whose names could drift without moving the hash would
  // let two different transcriptions claim the same provenance.
  assert.notEqual(
    allowlistHash([{ ...(entries[0] as OfficialAllowlistEntry), pair: "OCI/xUSDC" }]),
    digest,
  );
  assert.equal(allowlistHash([]), "c2c013c86a9c92e22f966f3d8617768f8b7a44c902adcc097bfa1e098afb4e1f");
});

test("each kind lands on its own register leg", () => {
  const sources = allowlistWeightSources([
    { kind: "Lsulp", dex: "X", pair: "LSULP", component: "component_l", resource: "resource_l" },
    { kind: "NativePool", dex: "X", pair: "A/XRD", component: "pool_a", resource: "resource_a" },
    { kind: "PrecisionPool", dex: "X", pair: "B/XRD", component: "component_b", resource: "resource_b" },
    { kind: "ShapePool", dex: "X", pair: "C/XRD", component: "component_c", resource: "resource_c" },
  ]);
  assert.deepEqual(sources.native_pools, { mode: "allowlist", pools: ["pool_a"] });
  assert.deepEqual(sources.lsulp, { mode: "component", component: "component_l", resource: "resource_l" });
  assert.deepEqual(sources.precision_pools, { mode: "allowlist", pools: ["component_b"] });
  assert.deepEqual(sources.shape_pools, { mode: "allowlist", pools: ["component_c"] });
});
