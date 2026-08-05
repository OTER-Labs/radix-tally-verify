/**
 * Weight recomputation: one account's voting weight at the state version the tally document
 * pins, derived from Gateway historical state.
 *
 * This is an independent implementation of the rule the reference engine states in its
 * WEIGHT_RULE string (which travels inside every document), not a port of its code:
 *
 *   weight(account) = XRD balance
 *                   + Σ over validator stake units held:
 *                       lsu_balance × validator_stake_xrd ÷ lsu_total_supply
 *                   + Σ over native pool units held:
 *                       unit_balance × pool_xrd_backing ÷ unit_total_supply
 *
 * where a pool's XRD backing is its own XRD vault plus its LSUs converted by the same rule.
 * Which pool units count is governed by the document's own `weight_sources` register — this
 * module reads the register from the document and applies it; it has no rule of its own.
 *
 * Two bounds are inherited from the reference rule and kept deliberately, because both fail
 * toward under-counting rather than over-counting: pool units held BY a pool are not followed
 * (one level only), and non-fungible liquidity positions are not counted at all — a position
 * NFT's backing is not readable from balances alone.
 *
 * All arithmetic is src/decimal.ts — scrypto Decimal, truncating division, no floats. The
 * conversions divide, and the eighteenth decimal place of a redemption rate is exactly where
 * a float would lie.
 */

import { Dec } from "./decimal.ts";
import { GatewayError, asArray, asObject, asString } from "./gateway.ts";
import type { GatewayClient } from "./gateway.ts";

/** Bech32 prefixes of NATIVE pool components. Only the engine's pool blueprints allocate
 * addresses in these spaces, so an attacker-written component cannot inhabit them — the
 * prefix check is half of what makes a pool-unit claim confirmable. */
const POOL_ADDRESS_PREFIXES = ["pool_rdx", "pool_tdx", "pool_sim"];

/** Details endpoint accepts 20 addresses per call. */
const ENTITY_DETAILS_CHUNK = 20;

/**
 * Hard stop on fungible-page walks for one account. Ten thousand distinct resources is far
 * past any real holder; hitting it means the cursor is looping, and a looping cursor must
 * fail the verification rather than return a weight that silently stopped early.
 */
const MAX_FUNGIBLE_PAGES = 100;

/** The document's Tier 2 weight-source register, native-pool leg. */
export type NativePoolSources =
  | { mode: "off" }
  | { mode: "all" }
  | { mode: "allowlist"; pools: string[] };

export interface WeightSources {
  native_pools: NativePoolSources;
}

/** What a held fungible turns out to be once looked up at the snapshot. */
export interface ResourceInfo {
  totalSupply: Dec;
  /** The pool this resource CLAIMS to be the unit of. Only a claim — metadata is set by
   * whoever created the resource. `verifiedPoolUnits` is what turns it into a fact. */
  pool: string | null;
}

type Balances = Map<string, Dec>; // resource -> amount

/** Absorb one page of Global-aggregated fungible items into an account's balance map. */
function absorbFungibleItems(items: unknown, balances: Balances): void {
  for (const f of asArray(items)) {
    const resource = asString(asObject(f)["resource_address"]) ?? "";
    const amount = asString(asObject(f)["amount"]) ?? "0";
    if (resource !== "") balances.set(resource, Dec.parse(amount));
  }
}

/**
 * Spend a `next_cursor` until the account's fungible list is exhausted. A voter's LSU
 * positions are exactly the long tail that falls off page one, so truncating there would
 * silently under-weight the diversified stakers the rule exists to include. A stalled or
 * runaway cursor is an error, not a partial answer: a short weight that gets compared
 * against the document reads as a lie that isn't one.
 */
async function drainFungiblePages(
  gw: GatewayClient,
  address: string,
  firstCursor: string,
  stateVersion: number,
  balances: Balances,
): Promise<void> {
  let cursor = firstCursor;
  for (let page = 0; page < MAX_FUNGIBLE_PAGES; page++) {
    const resp = asObject(await gw.entityFungiblesPage(address, cursor, stateVersion));
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(
        `gateway refused a fungible page of ${address} at sv ${stateVersion}: ${message}`,
      );
    }
    absorbFungibleItems(resp["items"], balances);
    const next = asString(resp["next_cursor"]);
    if (next === null) return;
    if (next === cursor) {
      throw new GatewayError(
        `gateway returned a non-advancing fungible cursor for ${address} at sv ${stateVersion}`,
      );
    }
    cursor = next;
  }
  throw new GatewayError(
    `fungible resources of ${address} at sv ${stateVersion} did not end within ${MAX_FUNGIBLE_PAGES} pages`,
  );
}

/** Fungible balances per entity at a state version: account -> (resource -> amount), all pages. */
async function fetchFungiblesAt(
  gw: GatewayClient,
  addresses: string[],
  stateVersion: number,
): Promise<Map<string, Balances>> {
  const out = new Map<string, Balances>();
  for (let i = 0; i < addresses.length; i += ENTITY_DETAILS_CHUNK) {
    const chunk = addresses.slice(i, i + ENTITY_DETAILS_CHUNK);
    const resp = asObject(await gw.entityDetails(chunk, stateVersion, { global: true, explicitMetadata: [] }));
    const spill: Array<[string, string]> = [];
    for (const item of asArray(resp["items"])) {
      const o = asObject(item);
      const address = asString(o["address"]) ?? "";
      const balances: Balances = new Map();
      const fungibles = asObject(o["fungible_resources"]);
      absorbFungibleItems(fungibles["items"], balances);
      const cursor = asString(fungibles["next_cursor"]);
      if (cursor !== null) spill.push([address, cursor]);
      out.set(address, balances);
    }
    for (const [address, cursor] of spill) {
      const balances = out.get(address) ?? new Map();
      await drainFungiblePages(gw, address, cursor, stateVersion, balances);
      out.set(address, balances);
    }
  }
  return out;
}

/** Validator stake-unit map at a state version: lsu resource -> the validator's stake in XRD. */
async function fetchValidatorLsuMap(
  gw: GatewayClient,
  stateVersion: number,
): Promise<Map<string, Dec>> {
  const map = new Map<string, Dec>();
  let cursor: string | null = null;
  do {
    const resp = asObject(await gw.validatorsList(stateVersion, cursor));
    const validators = asObject(resp["validators"]);
    for (const v of asArray(validators["items"])) {
      const o = asObject(v);
      const stake = asString(asObject(o["stake_vault"])["balance"]) ?? "0";
      const state = asObject(o["state"]);
      const lsu =
        asString(state["stake_unit_resource_address"]) ??
        asString(state["stake_unit_resource"]) ??
        asString(o["stake_unit_resource_address"]);
      // A validator whose LSU resource can't be located is skipped; its holders fall back to
      // XRD-only for that position, which under-counts rather than over-counts.
      if (lsu !== null) map.set(lsu, Dec.parse(stake));
    }
    cursor = asString(validators["next_cursor"]);
  } while (cursor !== null);
  return map;
}

/** One `explicit_metadata` string value, or null when the key is absent. */
function metadataLink(item: Record<string, unknown>, key: string): string | null {
  const items = asArray(asObject(item["explicit_metadata"])["items"]);
  for (const m of items) {
    const o = asObject(m);
    if (asString(o["key"]) === key) {
      return asString(asObject(asObject(o["value"])["typed"])["value"]);
    }
  }
  return null;
}

/** Total supply and claimed pool linkage for the given fungible resources at a state version. */
async function fetchResourceInfoAt(
  gw: GatewayClient,
  resources: string[],
  stateVersion: number,
): Promise<Map<string, ResourceInfo>> {
  const out = new Map<string, ResourceInfo>();
  for (let i = 0; i < resources.length; i += ENTITY_DETAILS_CHUNK) {
    const chunk = resources.slice(i, i + ENTITY_DETAILS_CHUNK);
    const resp = asObject(
      await gw.entityDetails(chunk, stateVersion, { global: false, explicitMetadata: ["pool"] }),
    );
    for (const item of asArray(resp["items"])) {
      const o = asObject(item);
      const address = asString(o["address"]) ?? "";
      const supply = asString(asObject(o["details"])["total_supply"]) ?? "0";
      out.set(address, { totalSupply: Dec.parse(supply), pool: metadataLink(o, "pool") });
    }
  }
  return out;
}

/** What each of these pool components declares as ITS pool unit, at a state version. */
async function fetchDeclaredPoolUnitsAt(
  gw: GatewayClient,
  pools: string[],
  stateVersion: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < pools.length; i += ENTITY_DETAILS_CHUNK) {
    const chunk = pools.slice(i, i + ENTITY_DETAILS_CHUNK);
    const resp = asObject(
      await gw.entityDetails(chunk, stateVersion, { global: false, explicitMetadata: ["pool_unit"] }),
    );
    for (const item of asArray(resp["items"])) {
      const o = asObject(item);
      const address = asString(o["address"]) ?? "";
      const unit = metadataLink(o, "pool_unit");
      if (unit !== null) out.set(address, unit);
    }
  }
  return out;
}

/**
 * Keep only the resource -> pool claims that the pool itself confirms.
 *
 * Both directions of the link are minted by the native pool blueprints as LOCKED metadata:
 * the unit gets `pool => <component>` and the component gets `pool_unit => <resource>`.
 * Trusting only the forward direction is a hole wide enough to drive a governance vote
 * through: anyone could mint a token, point its `pool` key at the fattest XRD pool on the
 * network, keep the entire supply, and be credited that pool's whole XRD balance.
 *
 * The register's say comes AFTER the authenticity checks: an allowlisted spoof must still
 * fail the round trip, and a genuine pool absent from the register must still be excluded.
 * The register decides which pools count, never what counts as a pool.
 */
export function verifiedPoolUnits(
  heldInfo: Map<string, ResourceInfo>,
  declaredUnits: Map<string, string>,
  sources: NativePoolSources,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [resource, info] of heldInfo) {
    if (info.pool === null) continue;
    const pool = info.pool;
    if (!POOL_ADDRESS_PREFIXES.some((p) => pool.startsWith(p))) continue;
    if (sources.mode === "off") continue;
    if (sources.mode === "allowlist" && !sources.pools.includes(pool)) continue;
    if (declaredUnits.get(pool) === resource) out.set(resource, pool);
  }
  return out;
}

/** The XRD a stake-unit balance represents, or zero when the resource is not a stake unit. */
function lsuValue(
  resource: string,
  amount: Dec,
  lsuMap: Map<string, Dec>,
  supplyOf: (resource: string) => Dec | null,
): Dec {
  const stakeXrd = lsuMap.get(resource);
  const supply = supplyOf(resource);
  if (stakeXrd === undefined || supply === null || !supply.isPositive()) return Dec.ZERO;
  return amount.mul(stakeXrd).div(supply);
}

/**
 * The weights of `accounts` at `snapshotStateVersion`, under the register the document
 * carries. Every number the verdict is later derived from comes out of this function, so
 * this is the place where a verifier earns its keep.
 */
export async function computeAccountWeights(
  gw: GatewayClient,
  accounts: string[],
  snapshotStateVersion: number,
  sources: WeightSources,
  xrdResource: string,
): Promise<Map<string, Dec>> {
  const weights = new Map<string, Dec>();
  if (accounts.length === 0) return weights;

  const fungibles = await fetchFungiblesAt(gw, accounts, snapshotStateVersion);
  const lsuMap = await fetchValidatorLsuMap(gw, snapshotStateVersion);

  // Everything the voters hold except XRD itself, looked up once: supply for the
  // conversions, `pool` metadata to find the pool units among them.
  const held = new Set<string>();
  for (const balances of fungibles.values()) {
    for (const resource of balances.keys()) {
      if (resource !== xrdResource) held.add(resource);
    }
  }
  const heldInfo = await fetchResourceInfoAt(gw, [...held], snapshotStateVersion);

  // Pool claims, confirmed against the pools themselves before any of them counts — unless
  // the register turns the leg off, in which case no pool lookup happens at all.
  let poolOf = new Map<string, string>();
  if (sources.native_pools.mode !== "off") {
    const claimedPools = new Set<string>();
    for (const info of heldInfo.values()) {
      if (info.pool !== null) claimedPools.add(info.pool);
    }
    const declaredUnits = await fetchDeclaredPoolUnitsAt(gw, [...claimedPools], snapshotStateVersion);
    poolOf = verifiedPoolUnits(heldInfo, declaredUnits, sources.native_pools);
  }

  // What the confirmed pools hold.
  const pools = [...new Set(poolOf.values())];
  const poolBalances = pools.length === 0
    ? new Map<string, Balances>()
    : await fetchFungiblesAt(gw, pools, snapshotStateVersion);

  // A pool may hold LSUs the voters do not hold directly, so their supplies are a second lookup.
  const poolLsus = new Set<string>();
  for (const balances of poolBalances.values()) {
    for (const resource of balances.keys()) {
      if (lsuMap.has(resource) && !heldInfo.has(resource)) poolLsus.add(resource);
    }
  }
  const poolLsuInfo = await fetchResourceInfoAt(gw, [...poolLsus], snapshotStateVersion);
  const supplyOf = (resource: string): Dec | null =>
    heldInfo.get(resource)?.totalSupply ?? poolLsuInfo.get(resource)?.totalSupply ?? null;

  // XRD backing per pool: its own XRD vault plus any LSUs it holds, converted by the same rule.
  const poolBacking = new Map<string, Dec>();
  for (const [pool, balances] of poolBalances) {
    let backing = balances.get(xrdResource) ?? Dec.ZERO;
    for (const [resource, amount] of balances) {
      backing = backing.add(lsuValue(resource, amount, lsuMap, supplyOf));
    }
    poolBacking.set(pool, backing);
  }

  for (const account of accounts) {
    const balances = fungibles.get(account) ?? new Map<string, Dec>();
    let weight = balances.get(xrdResource) ?? Dec.ZERO;
    for (const [resource, amount] of balances) {
      weight = weight.add(lsuValue(resource, amount, lsuMap, supplyOf));
      const pool = poolOf.get(resource);
      if (pool !== undefined) {
        const backing = poolBacking.get(pool);
        const supply = supplyOf(resource);
        if (backing !== undefined && supply !== null && supply.isPositive()) {
          weight = weight.add(amount.mul(backing).div(supply));
        }
      }
    }
    weights.set(account, weight);
  }
  return weights;
}
