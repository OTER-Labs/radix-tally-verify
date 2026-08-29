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
 *                   + (v16, when the register names an lsulp pair):
 *                       lsulp_balance × dex_valuation_xrd ÷ lsulp_total_supply
 *                   + (v17, when the register names precision_pools):
 *                       Σ over Ociswap PrecisionPool positions held: the XRD value of the
 *                       position's PRINCIPAL, from the tick formula in src/concentrated.ts
 *                   + (v17, when the register names shape_pools):
 *                       Σ over CaviarNine QuantaSwap receipts held: the XRD value of the
 *                       receipt's bin claims
 *
 * where a pool's XRD backing is its own XRD vault plus its LSUs converted by the same rule,
 * plus any register-named LSULP it holds at the same lsulp rate.
 * Which pool units count is governed by the document's own `weight_sources` register — this
 * module reads the register from the document and applies it; it has no rule of its own.
 *
 * One bound is inherited from the reference rule and kept deliberately, because it fails toward
 * under-counting rather than over-counting: pool units and liquidity positions held BY a pool
 * are not followed (one level only).
 *
 * The other bound v4-v16 carried — "non-fungible liquidity positions are not counted at all" —
 * is REVOKED at v17 for the two named legs, and only for them. A position of a pool the register
 * does not name still counts for nothing, and accrued fees stay uncounted everywhere.
 *
 * All arithmetic is src/decimal.ts — scrypto Decimal, truncating division, no floats — except
 * the tick power and removable-amount formula, which the rule evaluates in scrypto
 * PreciseDecimal (36 places, src/precise.ts) before narrowing back down. The conversions divide,
 * and the eighteenth decimal place of a redemption rate is exactly where a float would lie.
 */

import {
  WeightRuleError,
  fetchPositionDataAt,
  fetchPositionIdsAt,
  fetchPrecisionPoolsAt,
  fetchShapePoolsAt,
  parseLiquidityClaims,
  parseLiquidityPosition,
  precisionPositionXrd,
  shapeClaimsXrd,
} from "./concentrated.ts";
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

/**
 * The LSULP leg (tally document v16). Named-pair only, never discovered: the pricing input
 * (`dex_valuation_xrd`) is a number the named component reports about itself, with no
 * `pool_unit`-style back-reference to verify, so the document either names the exact
 * component + resource pair or the leg is off. The reference engine cross-checks the
 * self-report against the component's vaults as an operator diagnostic; the PUBLISHED rule —
 * and therefore this verifier — is the pure formula, so recomputation needs no judgment call.
 */
export type LsulpSource =
  | { mode: "off" }
  | { mode: "component"; component: string; resource: string };

/**
 * The two CONCENTRATED-LIQUIDITY legs (tally document v17): Ociswap `PrecisionPool` and
 * CaviarNine `QuantaSwap`. One type serves both because the register's decision is identical
 * for them — which pool COMPONENTS count. Everything else about a pool (its position resource,
 * its two token resources, its price or bin state) is read off the ledger at the snapshot.
 *
 * Named-or-off, with no discovery mode, for the LSULP reason one step stronger: a position's
 * value is not a pro-rata share of a vault balance but the OUTPUT OF A FORMULA over state fields
 * the component reports about itself, and both halves of the metadata round trip live in the
 * ordinary `component_`/`resource_` address spaces which anyone may occupy — so a mutual link
 * there shows only that one author wrote both halves.
 */
export type ConcentratedPoolSources =
  | { mode: "off" }
  | { mode: "allowlist"; pools: string[] };

/**
 * The DELEGATION leg (tally document v18): the component whose records say which account may
 * cast which other account's weight.
 *
 * Named-or-off, and only ever ONE component: a second register would be a second answer to the
 * question of who casts an account's weight, and the rule has no way to prefer one.
 *
 * This verifier carries the register entry but does not re-read the component's history — see
 * the delegation note in `src/delegation.ts` and the README's coverage table for exactly which
 * half of the leg is recomputed and which is a trusted input.
 */
export type DelegationSource =
  | { mode: "off" }
  | { mode: "component"; component: string };

export interface WeightSources {
  native_pools: NativePoolSources;
  /** Absent = off — v15 documents (and v16 documents that never enabled the leg) verify identically. */
  lsulp?: LsulpSource;
  /** Absent = off (v17). */
  precision_pools?: ConcentratedPoolSources;
  /** Absent = off (v17). */
  shape_pools?: ConcentratedPoolSources;
  /** Absent = off (v18). */
  delegation?: DelegationSource;
}

/** The components a concentrated-liquidity leg names, or none when it is off or absent. */
export function concentratedPools(leg: ConcentratedPoolSources | undefined): string[] {
  return leg !== undefined && leg.mode === "allowlist" ? leg.pools : [];
}

/** What a held fungible turns out to be once looked up at the snapshot. */
export interface ResourceInfo {
  totalSupply: Dec;
  /** The pool this resource CLAIMS to be the unit of. Only a claim — metadata is set by
   * whoever created the resource. `verifiedPoolUnits` is what turns it into a fact. */
  pool: string | null;
  /**
   * Decimal places the resource itself declares (engine state, not metadata). Only the
   * concentrated-liquidity legs use it, to truncate a computed token amount the way the amount
   * would be truncated if it were actually withdrawn. `null` for anything the Gateway reports
   * no divisibility for, which is every non-fungible.
   */
  divisibility: number | null;
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

/**
 * Fungible balances per entity at a state version: account -> (resource -> amount), all pages.
 *
 * Exported for the mirror-tally leg (`src/mirror.ts`): the OFFICIAL rule is liquid XRD only, no
 * LSU/pool/lsulp/concentrated conversion, so it reads exactly this and picks out `xrdResource` —
 * reusing the balance reader rather than a second implementation of fungible pagination.
 */
export async function fetchFungiblesAt(
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
      const details = asObject(o["details"]);
      const supply = asString(details["total_supply"]) ?? "0";
      const rawDiv = details["divisibility"];
      const divisibility =
        typeof rawDiv === "number" && Number.isSafeInteger(rawDiv) && rawDiv >= 0 ? rawDiv : null;
      out.set(address, {
        totalSupply: Dec.parse(supply),
        pool: metadataLink(o, "pool"),
        divisibility,
      });
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

/** One named `field_name` out of a component's Gateway-rendered state fields. */
function stateField(item: Record<string, unknown>, name: string): string | null {
  const fields = asArray(asObject(asObject(item["details"])["state"])["fields"]);
  for (const f of fields) {
    const o = asObject(f);
    if (asString(o["field_name"]) === name) return asString(o["value"]);
  }
  return null;
}

/** The pure LSULP rate: `dex_valuation_xrd ÷ total_supply`, a non-positive supply yielding 0. */
export function lsulpRateFrom(dexValuationXrd: Dec, totalSupply: Dec): Dec {
  return totalSupply.isPositive() ? dexValuationXrd.div(totalSupply) : Dec.ZERO;
}

/**
 * LSULP → XRD rate at the snapshot, from the document-named pair. Errors — rather than
 * zeroing — when the pair cannot be read: a register that names an unreadable source is a
 * broken document, and a silent zero would "verify" a tally while valuing every LSULP holder
 * at nothing.
 */
async function fetchLsulpRate(
  gw: GatewayClient,
  component: string,
  resource: string,
  stateVersion: number,
): Promise<Dec> {
  const resp = asObject(
    await gw.entityDetails([component, resource], stateVersion, { global: false, explicitMetadata: [] }),
  );
  const items = asArray(resp["items"]).map((i) => asObject(i));
  const compItem = items.find((i) => asString(i["address"]) === component);
  if (compItem === undefined) {
    throw new GatewayError(
      `lsulp register names component ${component}, which the gateway did not return at sv ${stateVersion}`,
    );
  }
  const valuation = stateField(compItem, "dex_valuation_xrd");
  if (valuation === null) {
    throw new GatewayError(
      `lsulp component ${component} has no dex_valuation_xrd state field at sv ${stateVersion}`,
    );
  }
  const resItem = items.find((i) => asString(i["address"]) === resource);
  if (resItem === undefined) {
    throw new GatewayError(
      `lsulp register names resource ${resource}, which the gateway did not return at sv ${stateVersion}`,
    );
  }
  const supply = asString(asObject(resItem["details"])["total_supply"]) ?? "0";
  return lsulpRateFrom(Dec.parse(valuation), Dec.parse(supply));
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
 * One account's weight, split by the leg that contributed it (mirror-tally `weight_delta_by_source`,
 * `src/mirror.ts`). `total` is the same figure `computeAccountWeights` returns for this account —
 * the split is additive, never a second computation of it.
 */
export interface WeightBreakdown {
  xrd: Dec;
  lsu: Dec;
  poolUnits: Dec;
  lsulp: Dec;
  precisionPools: Dec;
  shapePools: Dec;
  total: Dec;
}

/**
 * The weights of `accounts` at `snapshotStateVersion`, under the register the document
 * carries, split by leg. Every number the verdict is later derived from comes out of this
 * function, so this is the place where a verifier earns its keep.
 */
export async function computeAccountWeightBreakdown(
  gw: GatewayClient,
  accounts: string[],
  snapshotStateVersion: number,
  sources: WeightSources,
  xrdResource: string,
): Promise<Map<string, WeightBreakdown>> {
  const breakdown = new Map<string, WeightBreakdown>();
  if (accounts.length === 0) return breakdown;

  const fungibles = await fetchFungiblesAt(gw, accounts, snapshotStateVersion);
  const lsuMap = await fetchValidatorLsuMap(gw, snapshotStateVersion);

  // The LSULP leg, when the document's register names a pair: one rate for the whole tally,
  // read at the same state version as everything else.
  const lsulp = sources.lsulp;
  const lsulpRate =
    lsulp !== undefined && lsulp.mode === "component"
      ? { resource: lsulp.resource, rate: await fetchLsulpRate(gw, lsulp.component, lsulp.resource, snapshotStateVersion) }
      : null;
  const lsulpValue = (resource: string, amount: Dec): Dec =>
    lsulpRate !== null && resource === lsulpRate.resource ? amount.mul(lsulpRate.rate) : Dec.ZERO;

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

  // The concentrated-liquidity legs (v17), when the register names components. Resolved BEFORE
  // the supply lookup below, because a named pool's token resources join the set whose supply
  // and divisibility have to be known — a pool may pair an LSU no voter holds directly.
  const precisionPools = await fetchPrecisionPoolsAt(
    gw,
    concentratedPools(sources.precision_pools),
    snapshotStateVersion,
  );
  const shapePools = await fetchShapePoolsAt(
    gw,
    concentratedPools(sources.shape_pools),
    snapshotStateVersion,
  );
  const concentratedTokens = new Set<string>();
  for (const p of [...precisionPools, ...shapePools]) {
    if (!heldInfo.has(p.tokenX)) concentratedTokens.add(p.tokenX);
    if (!heldInfo.has(p.tokenY)) concentratedTokens.add(p.tokenY);
  }

  // A pool may hold LSUs the voters do not hold directly, so their supplies are a second lookup.
  const poolLsus = new Set<string>(concentratedTokens);
  for (const balances of poolBalances.values()) {
    for (const resource of balances.keys()) {
      if (lsuMap.has(resource) && !heldInfo.has(resource)) poolLsus.add(resource);
    }
  }
  const poolLsuInfo = await fetchResourceInfoAt(gw, [...poolLsus], snapshotStateVersion);
  const supplyOf = (resource: string): Dec | null =>
    heldInfo.get(resource)?.totalSupply ?? poolLsuInfo.get(resource)?.totalSupply ?? null;
  // The ENTRY is resolved first, then its divisibility read off it — not
  // `held?.divisibility ?? pool?.divisibility`, which would fall through to the second map when
  // the first knows the resource but reports no divisibility. Those are different answers: the
  // first says "this resource declares none", and reading a divisibility from somewhere else
  // would truncate a computed amount by a figure that belongs to a different lookup.
  const divisibilityOf = (resource: string): number | null => {
    const info = heldInfo.get(resource) ?? poolLsuInfo.get(resource);
    return info?.divisibility ?? null;
  };

  // XRD backing per pool: its own XRD vault plus any LSUs it holds, converted by the same
  // rule — plus any register-named LSULP it holds, at the same rate as directly-held LSULP.
  const poolBacking = new Map<string, Dec>();
  for (const [pool, balances] of poolBalances) {
    let backing = balances.get(xrdResource) ?? Dec.ZERO;
    for (const [resource, amount] of balances) {
      backing = backing.add(lsuValue(resource, amount, lsuMap, supplyOf));
      backing = backing.add(lsulpValue(resource, amount));
    }
    poolBacking.set(pool, backing);
  }

  // How one token amount out of a concentrated-liquidity position becomes XRD: the SAME three
  // recognitions the rest of the rule uses — XRD at par, a validator stake unit at its
  // redemption rate, the registered LSULP at `lsulp_rate` — and everything else at zero.
  // Nothing new is credited here; only a new way of arriving at a token amount.
  const valueInXrd = (resource: string, amount: Dec): Dec => {
    if (resource === xrdResource) return amount;
    return lsuValue(resource, amount, lsuMap, supplyOf).add(lsulpValue(resource, amount));
  };

  // Which position ids each account held, and what each position said — both at the snapshot,
  // both fetched ONCE per resource rather than per account.
  const positionResources = new Set<string>(
    [...precisionPools, ...shapePools].map((p) => p.positionResource),
  );
  const heldPositions = await fetchPositionIdsAt(
    gw,
    accounts,
    positionResources,
    snapshotStateVersion,
  );
  const positionData = new Map<string, Map<string, unknown>>();
  for (const resource of positionResources) {
    const ids = new Set<string>();
    for (const byResource of heldPositions.values()) {
      for (const id of byResource.get(resource) ?? []) ids.add(id);
    }
    if (ids.size === 0) continue;
    positionData.set(
      resource,
      await fetchPositionDataAt(gw, resource, [...ids], snapshotStateVersion),
    );
  }

  for (const account of accounts) {
    const balances = fungibles.get(account) ?? new Map<string, Dec>();
    const xrd = balances.get(xrdResource) ?? Dec.ZERO;
    let lsu = Dec.ZERO;
    let poolUnits = Dec.ZERO;
    let lsulpAmount = Dec.ZERO;
    for (const [resource, amount] of balances) {
      lsu = lsu.add(lsuValue(resource, amount, lsuMap, supplyOf));
      lsulpAmount = lsulpAmount.add(lsulpValue(resource, amount));
      const pool = poolOf.get(resource);
      if (pool !== undefined) {
        const backing = poolBacking.get(pool);
        const supply = supplyOf(resource);
        if (backing !== undefined && supply !== null && supply.isPositive()) {
          poolUnits = poolUnits.add(amount.mul(backing).div(supply));
        }
      }
    }

    // v17: the account's concentrated-liquidity positions. A position id with no data at the
    // snapshot was burned by then (or never existed) and contributes zero; a position that IS
    // there but does not parse is a refusal, not a zero, because a position we cannot read is
    // not a position worth nothing.
    const positionsOf = (resource: string): string[] =>
      heldPositions.get(account)?.get(resource) ?? [];
    let precisionPoolsAmount = Dec.ZERO;
    for (const pool of precisionPools) {
      const data = positionData.get(pool.positionResource);
      for (const id of positionsOf(pool.positionResource)) {
        const raw = data?.get(id);
        if (raw === undefined) continue;
        const position = parseLiquidityPosition(raw);
        if (position === null) {
          throw new WeightRuleError(
            `precision pool ${pool.component}: position ${id} does not carry a readable ` +
              `liquidity/left_bound/right_bound at sv ${snapshotStateVersion}`,
          );
        }
        precisionPoolsAmount = precisionPoolsAmount.add(
          precisionPositionXrd(position, pool, divisibilityOf, valueInXrd),
        );
      }
    }
    let shapePoolsAmount = Dec.ZERO;
    for (const pool of shapePools) {
      const data = positionData.get(pool.positionResource);
      for (const id of positionsOf(pool.positionResource)) {
        const raw = data?.get(id);
        if (raw === undefined) continue;
        const claims = parseLiquidityClaims(raw);
        if (claims === null) {
          throw new WeightRuleError(
            `shape pool ${pool.component}: receipt ${id} does not carry readable ` +
              `liquidity_claims at sv ${snapshotStateVersion}`,
          );
        }
        shapePoolsAmount = shapePoolsAmount.add(shapeClaimsXrd(claims, pool, valueInXrd));
      }
    }
    const total = xrd
      .add(lsu)
      .add(poolUnits)
      .add(lsulpAmount)
      .add(precisionPoolsAmount)
      .add(shapePoolsAmount);
    breakdown.set(account, {
      xrd,
      lsu,
      poolUnits,
      lsulp: lsulpAmount,
      precisionPools: precisionPoolsAmount,
      shapePools: shapePoolsAmount,
      total,
    });
  }
  return breakdown;
}

/**
 * The weights of `accounts` at `snapshotStateVersion`, under the register the document
 * carries. Every number the verdict is later derived from comes out of this function, so
 * this is the place where a verifier earns its keep.
 *
 * A thin wrapper over {@link computeAccountWeightBreakdown}: same reads, same arithmetic, just
 * the per-leg split discarded for callers that only want the total.
 */
export async function computeAccountWeights(
  gw: GatewayClient,
  accounts: string[],
  snapshotStateVersion: number,
  sources: WeightSources,
  xrdResource: string,
): Promise<Map<string, Dec>> {
  const breakdown = await computeAccountWeightBreakdown(
    gw,
    accounts,
    snapshotStateVersion,
    sources,
    xrdResource,
  );
  const weights = new Map<string, Dec>();
  for (const [account, b] of breakdown) weights.set(account, b.total);
  return weights;
}
