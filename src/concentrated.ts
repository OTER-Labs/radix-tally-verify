/**
 * The two CONCENTRATED-LIQUIDITY legs of the weight rule (tally document v17): Ociswap
 * `PrecisionPool` positions and CaviarNine `QuantaSwap` receipts.
 *
 * v17 is the first version that counts a NON-FUNGIBLE. Every leg before it valued a BALANCE, so
 * a fungible balance plus a redemption rate was the whole read; a concentrated-liquidity
 * position's value is a range, and the rule pays for counting it with a read path none of the
 * earlier legs needed — per-account position ids, per-position NFT data, per-pool vault
 * resources, and a full key-value-store walk of each shape pool's bin map, all pinned to the
 * snapshot state version.
 *
 * This is an independent implementation of what `WEIGHT_RULE` states, not a port of the
 * reference engine's code. Two properties of the rule are worth stating here because they are
 * where a careless implementation silently disagrees:
 *
 *   1. **The arithmetic is 36-place fixed point, evaluated by exponentiation by squaring with
 *      truncation after every multiplication** — see `src/precise.ts`. The tick power is not
 *      "1.0001 to the power of t" evaluated however the language likes; two implementations that
 *      round differently mid-way produce different digits, and this number is hashed.
 *   2. **The three-branch split is load-bearing.** A position whose range sits entirely below
 *      the current price holds only x, one entirely above holds only y, one straddling holds
 *      both. Crediting an out-of-range position at full notional in BOTH tokens would be a
 *      weight-farming surface: park liquidity in an unreachable range, take no
 *      impermanent-loss risk, collect full weight.
 *
 * Principal only. Accrued fees are not counted, which continues the rule's habit of failing
 * toward under-counting rather than over-counting.
 */

import { Dec } from "./decimal.ts";
import { PDec, PRECISE_DECIMAL_PLACES } from "./precise.ts";
import { GatewayError, asArray, asObject, asString } from "./gateway.ts";
import type { GatewayClient } from "./gateway.ts";

/**
 * The document's own register names something the ledger says it is not, or a position that IS
 * there cannot be read.
 *
 * Distinct from `GatewayError`, which says the infrastructure did not answer. This says the
 * infrastructure answered and the answer contradicts the document — a document whose stated
 * weight rule cannot be applied to the ledger it pins is not one this tool can verify either
 * way, so it is reported as MALFORMED rather than as a discrepancy. Calling it a discrepancy
 * would accuse a publisher of arithmetic they never got to do.
 */
export class WeightRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeightRuleError";
  }
}

/** The blueprint names the ENGINE must report before a named component's positions are valued. */
export const PRECISION_POOL_BLUEPRINT = "PrecisionPool";
export const SHAPE_POOL_BLUEPRINT = "QuantaSwap";

/**
 * The tick base: a price ratio of 1.0001 per tick means a price-SQUARE-ROOT ratio of
 * sqrt(1.0001) per tick. Stated as a literal, exactly as `WEIGHT_RULE` publishes it, because a
 * challenger must start from the same digits — recomputing the square root would be a second
 * place for the constant to differ.
 */
export const TICK_BASE_SQRT = "1.000049998750062496094023416993798697";

/** Ids per `/state/non-fungible/data` and keys per `/state/key-value-store/data` request. */
const NON_FUNGIBLE_DATA_CHUNK = 100;
/** Details endpoint accepts 20 addresses per call. */
const ENTITY_DETAILS_CHUNK = 20;
/** Hard stop on each of the three non-fungible page walks. */
const MAX_NON_FUNGIBLE_PAGES = 100;
/** Hard stop on the bin-map key walk. A truncated bin map under-values every receipt past the cut. */
const MAX_KVS_PAGES = 200;

/** A named, verified Ociswap precision pool at the snapshot. */
export interface PrecisionPool {
  component: string;
  /** The `lp_manager` the component's own state names — the position NFT resource. */
  positionResource: string;
  tokenX: string;
  tokenY: string;
  /** The component's `price_sqrt` state field at the snapshot. */
  priceSqrt: PDec;
}

/** One Ociswap `LiquidityPosition`, reduced to the three fields principal needs. */
export interface LiquidityPosition {
  liquidity: PDec;
  leftBound: number;
  rightBound: number;
}

/** A named, verified CaviarNine shape pool at the snapshot, bin map included. */
export interface ShapePool {
  component: string;
  /** The `liquidity_receipt_manager` the component's own state names. */
  positionResource: string;
  tokenX: string;
  tokenY: string;
  /**
   * `tick_index.current`. `null` — a pool with no active tick — makes every receipt of it worth
   * zero, which is the only defensible answer: without a current tick there is no rule for
   * which side of the book a claim sits on.
   */
  currentTick: number | null;
  activeX: Dec;
  activeY: Dec;
  activeTotalClaim: Dec;
  /** tick -> [bin amount, bin total_claim], the whole `bin_map` KV store at the snapshot. */
  bins: Map<number, [Dec, Dec]>;
}

/**
 * A `Decimal` from a Gateway state field, an unparseable one reading as ZERO.
 *
 * Lenient on purpose, and only here. Every `Decimal` inside a tally DOCUMENT is parsed strictly,
 * because a malformed one there means the document did not come from where the caller thinks.
 * These are third-party components' own state fields, and the reference implementation reads
 * them with the same zero default — so a verifier that threw on one would report UNVERIFIABLE
 * where the engine computed a number, which is a disagreement invented by the verifier rather
 * than found by it.
 */
function decOrZero(s: string): Dec {
  try {
    return Dec.parse(s);
  } catch {
    return Dec.ZERO;
  }
}

/** How one token amount becomes XRD — XRD at par, an LSU at its rate, LSULP at `lsulp_rate`,
 * anything else zero. Supplied by the caller so nothing NEW is credited here. */
export type ValueInXrd = (resource: string, amount: Dec) => Dec;
/** A resource's declared divisibility, or null when the Gateway reported none. */
export type DivisibilityOf = (resource: string) => number | null;

/* ---- the pure rule -------------------------------------------------------- */

/**
 * The price square root at a tick: `TICK_BASE_SQRT^tick`, by the published algorithm.
 *
 * `null` when the power leaves the representable range, rather than a clamp: the caller turns
 * that into a refusal, since a silently clamped price values the position wrongly instead of
 * loudly.
 */
export function tickPriceSqrt(tick: number): PDec | null {
  return PDec.parse(TICK_BASE_SQRT).powi(BigInt(tick));
}

/**
 * Uniswap-v3 removable amounts for one position, in the pool's own x and y tokens.
 *
 * `null` on any arithmetic that leaves the representable range, for the same reason as
 * {@link tickPriceSqrt}.
 */
export function removableAmounts(
  liquidity: PDec,
  priceSqrt: PDec,
  leftSqrt: PDec,
  rightSqrt: PDec,
): [PDec, PDec] | null {
  const zero = PDec.ZERO;
  // A degenerate or inverted range holds nothing. Guarding here also keeps every division below
  // away from zero.
  if (!leftSqrt.isPositive() || rightSqrt.lte(leftSqrt) || !liquidity.isPositive()) {
    return [zero, zero];
  }
  // x = L/p - L/right, floored at zero.
  const xFrom = (p: PDec): PDec | null => {
    const a = liquidity.div(p);
    if (a === null) return null;
    const b = liquidity.div(rightSqrt);
    if (b === null) return null;
    const d = a.subtract(b);
    if (d === null) return null;
    return d.isNegative() ? zero : d;
  };
  if (priceSqrt.lte(leftSqrt)) {
    // Entirely below the range: all x.
    const x = xFrom(leftSqrt);
    return x === null ? null : [x, zero];
  }
  if (priceSqrt.gte(rightSqrt)) {
    // Entirely above the range: all y.
    const span = rightSqrt.subtract(leftSqrt);
    if (span === null) return null;
    const y = liquidity.mul(span);
    return y === null ? null : [zero, y];
  }
  const x = xFrom(priceSqrt);
  if (x === null) return null;
  const span = priceSqrt.subtract(leftSqrt);
  if (span === null) return null;
  const y = liquidity.mul(span);
  return y === null ? null : [x, y];
}

/**
 * Truncate a computed token amount to the resource's own divisibility, the way the amount would
 * be truncated if it were actually withdrawn. An unreported divisibility (or 18, our own scale)
 * leaves the amount alone.
 *
 * In practice this never bites — the only resources the rule credits are XRD, validator stake
 * units and LSULP, all divisibility 18. It is applied anyway because the register does not
 * restrict which token a named pool pairs.
 */
export function floorToDivisibility(amount: Dec, divisibility: number | null): Dec {
  return divisibility !== null && divisibility < 18 ? amount.truncateToPlaces(divisibility) : amount;
}

/** Narrow a 36-place amount to the tally's 18, or refuse. */
function narrow(v: PDec, component: string, token: string): Dec {
  const d = Dec.fromPreciseSubunits(v.sub, PRECISE_DECIMAL_PLACES);
  if (d === null) {
    throw new WeightRuleError(
      `precision pool ${component}: ${token} amount ${v.toString()} does not fit the tally's Decimal scale`,
    );
  }
  return d;
}

/**
 * The XRD value of ONE precision-pool position: its principal, valued leg by leg.
 *
 * Throws rather than zeroing when the arithmetic leaves the representable range — the number is
 * hashed and bonded on, and a clamped weight is a wrong weight.
 */
export function precisionPositionXrd(
  position: LiquidityPosition,
  pool: PrecisionPool,
  divisibilityOf: DivisibilityOf,
  valueInXrd: ValueInXrd,
): Dec {
  if (!position.liquidity.isPositive()) return Dec.ZERO;
  const left = tickPriceSqrt(position.leftBound);
  if (left === null) {
    throw new WeightRuleError(
      `precision pool ${pool.component}: tick ${position.leftBound} is outside the representable price range`,
    );
  }
  const right = tickPriceSqrt(position.rightBound);
  if (right === null) {
    throw new WeightRuleError(
      `precision pool ${pool.component}: tick ${position.rightBound} is outside the representable price range`,
    );
  }
  const amounts = removableAmounts(position.liquidity, pool.priceSqrt, left, right);
  if (amounts === null) {
    throw new WeightRuleError(
      `precision pool ${pool.component}: position over [${position.leftBound}, ${position.rightBound}] does not evaluate in range`,
    );
  }
  const x = floorToDivisibility(
    narrow(amounts[0], pool.component, pool.tokenX),
    divisibilityOf(pool.tokenX),
  );
  const y = floorToDivisibility(
    narrow(amounts[1], pool.component, pool.tokenY),
    divisibilityOf(pool.tokenY),
  );
  return valueInXrd(pool.tokenX, x).add(valueInXrd(pool.tokenY, y));
}

/**
 * The XRD value of ONE shape-pool receipt: its `liquidity_claims`, resolved bin by bin.
 *
 * A claim below the current tick redeems in y, one above redeems in x, and one AT the current
 * tick redeems pro-rata into both out of the pool's active reserves. A tick with no bin, or a
 * bin nobody has a claim on, is worth zero rather than an error: a bin map legitimately omits
 * ticks that carry no liquidity, and the Gateway omits a KV key that does not exist rather than
 * reporting it — "absent" here means "empty", not "unreadable".
 */
export function shapeClaimsXrd(
  claims: Map<number, Dec>,
  pool: ShapePool,
  valueInXrd: ValueInXrd,
): Dec {
  const current = pool.currentTick;
  if (current === null) return Dec.ZERO;
  let amountX = Dec.ZERO;
  let amountY = Dec.ZERO;
  // Ascending tick order, mirroring the reference implementation's ordered map. Addition is
  // exact fixed point, so the order does not change the sum — it is kept so the two
  // implementations remain readable side by side.
  const ticks = [...claims.keys()].sort((a, b) => a - b);
  for (const tick of ticks) {
    const claim = claims.get(tick) as Dec;
    if (tick === current) {
      if (!pool.activeTotalClaim.isPositive()) continue;
      const share = claim.div(pool.activeTotalClaim);
      amountX = amountX.add(pool.activeX.mul(share));
      amountY = amountY.add(pool.activeY.mul(share));
      continue;
    }
    const bin = pool.bins.get(tick);
    if (bin === undefined) continue;
    const [amount, totalClaim] = bin;
    if (!totalClaim.isPositive()) continue;
    const share = claim.div(totalClaim);
    if (tick < current) {
      amountY = amountY.add(share.mul(amount));
    } else {
      amountX = amountX.add(share.mul(amount));
    }
  }
  return valueInXrd(pool.tokenX, amountX).add(valueInXrd(pool.tokenY, amountY));
}

/* ---- reading the ledger --------------------------------------------------- */

/** One `field_name` out of a component's Gateway-rendered state, as the raw JSON node. */
function stateFieldRaw(item: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const fields = asArray(asObject(asObject(item["details"])["state"])["fields"]);
  for (const f of fields) {
    const o = asObject(f);
    if (asString(o["field_name"]) === name) return o;
  }
  return null;
}

/** One named `field_name` as its string value. */
export function stateField(item: Record<string, unknown>, name: string): string | null {
  const f = stateFieldRaw(item, name);
  return f === null ? null : asString(f["value"]);
}

/** A QuantaSwap's `tick_index.current`, or null when the pool has no active tick. */
export function quantaCurrentTick(item: Record<string, unknown>): number | null {
  const tickIndex = stateFieldRaw(item, "tick_index");
  if (tickIndex === null) return null;
  const current = asArray(tickIndex["fields"])
    .map((f) => asObject(f))
    .find((f) => asString(f["field_name"]) === "current");
  if (current === undefined) return null;
  if (asString(current["variant_name"]) !== "Some") return null;
  // Some(Tick(u32)) — the Option's payload is the Tick tuple, whose sole field is the number.
  const payload = asObject(asArray(current["fields"])[0]);
  const inner = asObject(asArray(payload["fields"])[0]);
  const raw = asString(inner["value"]);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * vault_address -> resource_address for one entity, from a Vault-aggregation details response.
 *
 * This is how a pool's two token resources are learned: the component's state names its vaults,
 * and the ENGINE says what each vault holds. Metadata (`x_address`, `token_x`) says the same
 * thing but is a claim by whoever may update the component's metadata, and the token identity
 * decides whether a leg is credited as XRD at all.
 */
export function vaultResourceMap(item: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of asArray(asObject(item["fungible_resources"])["items"])) {
    const o = asObject(r);
    const resource = asString(o["resource_address"]);
    if (resource === null) continue;
    for (const v of asArray(asObject(o["vaults"])["items"])) {
      const vault = asString(asObject(v)["vault_address"]);
      if (vault !== null) out.set(vault, resource);
    }
  }
  return out;
}

/**
 * Common verification for a named concentrated-liquidity pool, applied before any of its
 * positions is valued: the ENGINE must report the expected blueprint (a component cannot lie
 * about which package's code it runs), the component's own state must name the position
 * resource, and that resource must name the component back.
 *
 * A register entry that fails any of these is an ERROR, not a skip. It means the document names
 * an address that is not the thing it claims — and a tally that quietly dropped it would weigh
 * an electorate nobody chose.
 */
export function verifyNamedPool(
  item: Record<string, unknown>,
  component: string,
  expectedBlueprint: string,
  managerField: string,
  backLinks: Map<string, string[]>,
): string {
  const blueprint = asString(asObject(item["details"])["blueprint_name"]) ?? "";
  if (blueprint !== expectedBlueprint) {
    throw new WeightRuleError(
      `weight-source register names ${component} as a ${expectedBlueprint}, but the ledger ` +
        `reports its blueprint as ${JSON.stringify(blueprint)}`,
    );
  }
  const resource = stateField(item, managerField);
  if (resource === null) {
    throw new WeightRuleError(
      `${expectedBlueprint} ${component} has no ${managerField} state field`,
    );
  }
  const namedBack = (backLinks.get(resource) ?? []).includes(component);
  if (!namedBack) {
    throw new WeightRuleError(
      `${expectedBlueprint} ${component} names position resource ${resource}, which does not ` +
        `name it back — both directions are required`,
    );
  }
  return resource;
}

/**
 * The token resources behind a pool's two liquidity-vault state fields.
 *
 * Each side is a LIST of candidate field names because Ociswap's two precision packages
 * disagree: V1 names its vaults `x_vault`/`y_vault`, V2 names them `x_liquidity`/`y_liquidity`.
 * Both report the blueprint as `PrecisionPool`, so the blueprint name cannot tell them apart.
 * Matching on only one name silently drops the majority of the live pools.
 */
export function poolTokenPair(
  item: Record<string, unknown>,
  component: string,
  xFields: string[],
  yFields: string[],
): [string, string] {
  const vaults = vaultResourceMap(item);
  const resolve = (fields: string[]): string => {
    let found: [string, string] | null = null;
    for (const f of fields) {
      const v = stateField(item, f);
      if (v !== null) {
        found = [f, v];
        break;
      }
    }
    if (found === null) {
      throw new WeightRuleError(
        `pool ${component} has none of the ${JSON.stringify(fields)} liquidity-vault state fields`,
      );
    }
    const [field, vault] = found;
    const resource = vaults.get(vault);
    if (resource === undefined) {
      throw new WeightRuleError(
        `pool ${component}: the resource of vault ${vault} (${field}) is not readable`,
      );
    }
    return resource;
  };
  return [resolve(xFields), resolve(yFields)];
}

/** The state fields an Ociswap precision pool holds its two token vaults in — V1's first, then V2's. */
export const PRECISION_X_VAULT_FIELDS = ["x_vault", "x_liquidity"];
export const PRECISION_Y_VAULT_FIELDS = ["y_vault", "y_liquidity"];

/**
 * The pool components the register named, fetched at the snapshot with their vault map.
 *
 * Components the Gateway does not return did not exist at that state version — an expected state
 * for any register that outlives a pool's deployment — so they are dropped rather than failing
 * the verification.
 */
async function fetchPoolEntitiesAt(
  gw: GatewayClient,
  components: string[],
  stateVersion: number,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < components.length; i += ENTITY_DETAILS_CHUNK) {
    const chunk = components.slice(i, i + ENTITY_DETAILS_CHUNK);
    const resp = asObject(await gw.entityDetailsVault(chunk, stateVersion));
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(
        `gateway refused a weight-source pool read at sv ${stateVersion}: ${message}`,
      );
    }
    for (const item of asArray(resp["items"])) {
      const o = asObject(item);
      const address = asString(o["address"]);
      if (address !== null) out.set(address, o);
    }
  }
  return out;
}

/**
 * The components each of these resources claims to belong to, from the `pool` and `component`
 * metadata keys (Ociswap sets the first on a precision LP resource, CaviarNine the second on a
 * shape receipt). Used only to CONFIRM a register entry, never to discover one.
 */
async function fetchPositionBackLinksAt(
  gw: GatewayClient,
  resources: string[],
  stateVersion: number,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < resources.length; i += ENTITY_DETAILS_CHUNK) {
    const chunk = resources.slice(i, i + ENTITY_DETAILS_CHUNK);
    const resp = asObject(
      await gw.entityDetails(chunk, stateVersion, {
        global: false,
        explicitMetadata: ["pool", "component"],
      }),
    );
    for (const item of asArray(resp["items"])) {
      const o = asObject(item);
      const address = asString(o["address"]);
      if (address === null) continue;
      const links: string[] = [];
      for (const key of ["pool", "component"]) {
        const v = metadataLink(o, key);
        if (v !== null) links.push(v);
      }
      out.set(address, links);
    }
  }
  return out;
}

/** One `explicit_metadata` string value, or null when the key is absent. */
function metadataLink(item: Record<string, unknown>, key: string): string | null {
  for (const m of asArray(asObject(item["explicit_metadata"])["items"])) {
    const o = asObject(m);
    if (asString(o["key"]) === key) {
      return asString(asObject(asObject(o["value"])["typed"])["value"]);
    }
  }
  return null;
}

/** The register's named Ociswap precision pools, read and verified at the snapshot. */
export async function fetchPrecisionPoolsAt(
  gw: GatewayClient,
  components: string[],
  stateVersion: number,
): Promise<PrecisionPool[]> {
  if (components.length === 0) return [];
  const items = await fetchPoolEntitiesAt(gw, components, stateVersion);
  const managers: string[] = [];
  for (const item of items.values()) {
    const m = stateField(item, "lp_manager");
    if (m !== null) managers.push(m);
  }
  const backLinks = await fetchPositionBackLinksAt(gw, managers, stateVersion);

  const pools: PrecisionPool[] = [];
  for (const component of components) {
    const item = items.get(component);
    if (item === undefined) continue;
    const positionResource = verifyNamedPool(
      item,
      component,
      PRECISION_POOL_BLUEPRINT,
      "lp_manager",
      backLinks,
    );
    const raw = stateField(item, "price_sqrt");
    let priceSqrt: PDec | null = null;
    if (raw !== null) {
      try {
        priceSqrt = PDec.parse(raw);
      } catch {
        priceSqrt = null;
      }
    }
    if (priceSqrt === null) {
      throw new WeightRuleError(
        `precision pool ${component} has no readable price_sqrt at sv ${stateVersion}`,
      );
    }
    const [tokenX, tokenY] = poolTokenPair(
      item,
      component,
      PRECISION_X_VAULT_FIELDS,
      PRECISION_Y_VAULT_FIELDS,
    );
    pools.push({ component, positionResource, tokenX, tokenY, priceSqrt });
  }
  return pools;
}

/** The register's named CaviarNine shape pools, each with its bin map walked in full. */
export async function fetchShapePoolsAt(
  gw: GatewayClient,
  components: string[],
  stateVersion: number,
): Promise<ShapePool[]> {
  if (components.length === 0) return [];
  const items = await fetchPoolEntitiesAt(gw, components, stateVersion);
  const managers: string[] = [];
  for (const item of items.values()) {
    const m = stateField(item, "liquidity_receipt_manager");
    if (m !== null) managers.push(m);
  }
  const backLinks = await fetchPositionBackLinksAt(gw, managers, stateVersion);

  const pools: ShapePool[] = [];
  for (const component of components) {
    const item = items.get(component);
    if (item === undefined) continue;
    const positionResource = verifyNamedPool(
      item,
      component,
      SHAPE_POOL_BLUEPRINT,
      "liquidity_receipt_manager",
      backLinks,
    );
    const [tokenX, tokenY] = poolTokenPair(item, component, ["tokens_x"], ["tokens_y"]);
    const binMap = stateField(item, "bin_map");
    if (binMap === null) {
      throw new WeightRuleError(`shape pool ${component} has no bin_map state field`);
    }
    const bins = await fetchBinMapAt(gw, binMap, stateVersion);
    // An ABSENT field is a refusal — the component is not the shape the leg reads. An
    // unparseable one is zero, matching `parse_dec` in the reference implementation.
    const dec = (field: string): Dec => {
      const v = stateField(item, field);
      if (v === null) {
        throw new WeightRuleError(`shape pool ${component} has no ${field} state field`);
      }
      return decOrZero(v);
    };
    pools.push({
      component,
      positionResource,
      tokenX,
      tokenY,
      currentTick: quantaCurrentTick(item),
      activeX: dec("active_x"),
      activeY: dec("active_y"),
      activeTotalClaim: dec("active_total_claim"),
      bins,
    });
  }
  return pools;
}

/**
 * A shape pool's whole `bin_map` KV store at the snapshot: tick -> [amount, total_claim].
 *
 * Two passes, because the Gateway separates them: enumerate the keys (paged, with the same
 * non-advancing-cursor and page-cap discipline the fungible walk applies), then read the values
 * for those keys in chunks. A truncated bin map silently under-values every receipt that claims
 * a tick past the cut, so this fails rather than returning a short map.
 */
export async function fetchBinMapAt(
  gw: GatewayClient,
  kvsAddress: string,
  stateVersion: number,
): Promise<Map<number, [Dec, Dec]>> {
  const keys: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    const resp = asObject(await gw.keyValueStoreKeys(kvsAddress, cursor, stateVersion));
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(
        `gateway refused bin-map keys of ${kvsAddress} at sv ${stateVersion}: ${message}`,
      );
    }
    for (const item of asArray(resp["items"])) {
      keys.push(asObject(asObject(item)["key"])["programmatic_json"]);
    }
    const next = asString(resp["next_cursor"]);
    if (next === null) break;
    if (next === cursor) {
      throw new GatewayError(
        `gateway returned a non-advancing bin-map cursor for ${kvsAddress} at sv ${stateVersion}`,
      );
    }
    if (page + 1 >= MAX_KVS_PAGES) {
      throw new GatewayError(
        `bin map of ${kvsAddress} at sv ${stateVersion} did not end within ${MAX_KVS_PAGES} pages`,
      );
    }
    cursor = next;
  }

  const out = new Map<number, [Dec, Dec]>();
  for (let i = 0; i < keys.length; i += NON_FUNGIBLE_DATA_CHUNK) {
    const wanted = keys.slice(i, i + NON_FUNGIBLE_DATA_CHUNK).map((k) => ({ key_json: k }));
    const resp = asObject(await gw.keyValueStoreData(kvsAddress, wanted, stateVersion));
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(
        `gateway refused bin-map data of ${kvsAddress} at sv ${stateVersion}: ${message}`,
      );
    }
    for (const entry of asArray(resp["entries"])) {
      const parsed = parseBinEntry(asObject(entry));
      if (parsed !== null) out.set(parsed[0], parsed[1]);
    }
  }
  return out;
}

/** One `Tick(u32) -> Bin { amount, total_claim }` bin-map entry. */
export function parseBinEntry(entry: Record<string, unknown>): [number, [Dec, Dec]] | null {
  const keyJson = asObject(asObject(entry["key"])["programmatic_json"]);
  const tickRaw = asString(asObject(asArray(keyJson["fields"])[0])["value"]);
  if (tickRaw === null || !/^\d+$/.test(tickRaw)) return null;
  const tick = Number(tickRaw);
  if (!Number.isSafeInteger(tick)) return null;
  const valueJson = asObject(asObject(entry["value"])["programmatic_json"]);
  // A MISSING field means this is not a bin entry, and the caller skips the key. A present but
  // unparseable one is zero — `parse_dec`'s default, and a zero `total_claim` already means
  // "worth nothing" in the claim resolution.
  const named = (name: string): Dec | null => {
    const f = asArray(valueJson["fields"])
      .map((x) => asObject(x))
      .find((x) => asString(x["field_name"]) === name);
    if (f === undefined) return null;
    const s = asString(f["value"]);
    return s === null ? null : decOrZero(s);
  };
  const amount = named("amount");
  const totalClaim = named("total_claim");
  if (amount === null || totalClaim === null) return null;
  return [tick, [amount, totalClaim]];
}

/** The three principal fields of an Ociswap `LiquidityPosition`, or null on a shape change. */
export function parseLiquidityPosition(data: unknown): LiquidityPosition | null {
  const o = asObject(data);
  const field = (name: string): string | null => {
    const f = asArray(o["fields"])
      .map((x) => asObject(x))
      .find((x) => asString(x["field_name"]) === name);
    return f === undefined ? null : asString(f["value"]);
  };
  const liquidityRaw = field("liquidity");
  const leftRaw = field("left_bound");
  const rightRaw = field("right_bound");
  if (liquidityRaw === null || leftRaw === null || rightRaw === null) return null;
  let liquidity: PDec;
  try {
    liquidity = PDec.parse(liquidityRaw);
  } catch {
    return null;
  }
  if (!/^-?\d+$/.test(leftRaw) || !/^-?\d+$/.test(rightRaw)) return null;
  const leftBound = Number(leftRaw);
  const rightBound = Number(rightRaw);
  if (!Number.isSafeInteger(leftBound) || !Number.isSafeInteger(rightBound)) return null;
  return { liquidity, leftBound, rightBound };
}

/** The `liquidity_claims` map of a QuantaSwap `LiquidityReceipt`, or null on a shape change. */
export function parseLiquidityClaims(data: unknown): Map<number, Dec> | null {
  const o = asObject(data);
  const claims = asArray(o["fields"])
    .map((x) => asObject(x))
    .find((x) => asString(x["field_name"]) === "liquidity_claims");
  if (claims === undefined) return null;
  const out = new Map<number, Dec>();
  for (const entry of asArray(claims["entries"])) {
    const e = asObject(entry);
    const tickRaw = asString(asObject(e["key"])["value"]);
    if (tickRaw === null || !/^\d+$/.test(tickRaw)) return null;
    const tick = Number(tickRaw);
    if (!Number.isSafeInteger(tick)) return null;
    // An unreadable TICK makes the whole receipt unreadable — the claim would be resolved
    // against the wrong side of the book. An unparseable amount is zero, per `parse_dec`.
    const amountRaw = asString(asObject(e["value"])["value"]);
    if (amountRaw === null) return null;
    out.set(tick, decOrZero(amountRaw));
  }
  return out;
}

/** Absorb the ids inline in a `vaults` node. */
function absorbVaultIds(vaults: Record<string, unknown>, ids: string[]): void {
  for (const vault of asArray(vaults["items"])) {
    for (const id of asArray(asObject(vault)["items"])) {
      const s = asString(id);
      if (s !== null) ids.push(s);
    }
  }
}

/** Spend a per-VAULT id cursor until one vault's ids are exhausted. */
async function drainVaultIdPages(
  gw: GatewayClient,
  account: string,
  resource: string,
  vaultAddress: string,
  firstCursor: string,
  stateVersion: number,
  ids: string[],
): Promise<void> {
  let cursor = firstCursor;
  for (let page = 0; page < MAX_NON_FUNGIBLE_PAGES; page++) {
    const resp = asObject(
      await gw.entityNonFungibleVaultIdsPage(account, resource, vaultAddress, cursor, stateVersion),
    );
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(
        `gateway refused nfid page of vault ${vaultAddress} at sv ${stateVersion}: ${message}`,
      );
    }
    for (const id of asArray(resp["items"])) {
      const s = asString(id);
      if (s !== null) ids.push(s);
    }
    const next = asString(resp["next_cursor"]);
    if (next === null) return;
    if (next === cursor) {
      throw new GatewayError(
        `gateway returned a non-advancing nfid cursor for vault ${vaultAddress} at sv ${stateVersion}`,
      );
    }
    cursor = next;
  }
  throw new GatewayError(
    `ids of vault ${vaultAddress} at sv ${stateVersion} did not end within ${MAX_NON_FUNGIBLE_PAGES} pages`,
  );
}

/** Spend a per-RESOURCE vault cursor until every vault of one non-fungible resource is seen. */
async function drainVaultPages(
  gw: GatewayClient,
  account: string,
  resource: string,
  firstCursor: string,
  stateVersion: number,
  ids: string[],
): Promise<void> {
  let cursor = firstCursor;
  for (let page = 0; page < MAX_NON_FUNGIBLE_PAGES; page++) {
    const resp = asObject(
      await gw.entityNonFungibleVaultsPage(account, resource, cursor, stateVersion),
    );
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(
        `gateway refused vault page of ${resource} for ${account} at sv ${stateVersion}: ${message}`,
      );
    }
    const items = asArray(resp["items"]).map((v) => asObject(v));
    for (const vault of items) {
      for (const id of asArray(vault["items"])) {
        const s = asString(id);
        if (s !== null) ids.push(s);
      }
    }
    for (const vault of items) {
      const vaultAddress = asString(vault["vault_address"]);
      const next = asString(vault["next_cursor"]);
      if (vaultAddress !== null && next !== null) {
        await drainVaultIdPages(gw, account, resource, vaultAddress, next, stateVersion, ids);
      }
    }
    const next = asString(resp["next_cursor"]);
    if (next === null) return;
    if (next === cursor) {
      throw new GatewayError(
        `gateway returned a non-advancing vault cursor for ${resource} of ${account} at sv ${stateVersion}`,
      );
    }
    cursor = next;
  }
  throw new GatewayError(
    `vaults of ${resource} for ${account} at sv ${stateVersion} did not end within ${MAX_NON_FUNGIBLE_PAGES} pages`,
  );
}

/**
 * Which local ids of the WANTED non-fungible resources each account held at the snapshot.
 *
 * Three levels of pagination, all followed to exhaustion for the same reason the fungible walk
 * is: a liquidity provider's positions are exactly the long tail that falls off page one, and a
 * short answer here is an under-weight that gets hashed. Only wanted resources are drilled into,
 * so an account full of unrelated NFTs costs one page rather than a walk per collection.
 */
export async function fetchPositionIdsAt(
  gw: GatewayClient,
  accounts: string[],
  wanted: Set<string>,
  stateVersion: number,
): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  if (wanted.size === 0) return out;
  for (const account of accounts) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_NON_FUNGIBLE_PAGES; page++) {
      const resp = asObject(await gw.entityNonFungiblesPage(account, cursor, stateVersion));
      const message = asString(resp["message"]);
      if (message !== null) {
        throw new GatewayError(
          `gateway refused non-fungible page ${page + 1} of ${account} at sv ${stateVersion}: ${message}`,
        );
      }
      for (const item of asArray(resp["items"])) {
        const o = asObject(item);
        const resource = asString(o["resource_address"]);
        if (resource === null || !wanted.has(resource)) continue;
        const ids: string[] = [];
        const vaults = asObject(o["vaults"]);
        absorbVaultIds(vaults, ids);
        for (const v of asArray(vaults["items"])) {
          const vo = asObject(v);
          const vaultAddress = asString(vo["vault_address"]);
          const next = asString(vo["next_cursor"]);
          if (vaultAddress !== null && next !== null) {
            await drainVaultIdPages(gw, account, resource, vaultAddress, next, stateVersion, ids);
          }
        }
        const vaultSpill = asString(vaults["next_cursor"]);
        if (vaultSpill !== null) {
          await drainVaultPages(gw, account, resource, vaultSpill, stateVersion, ids);
        }
        let byResource = out.get(account);
        if (byResource === undefined) {
          byResource = new Map<string, string[]>();
          out.set(account, byResource);
        }
        byResource.set(resource, (byResource.get(resource) ?? []).concat(ids));
      }
      const next = asString(resp["next_cursor"]);
      if (next === null) break;
      if (next === cursor) {
        throw new GatewayError(
          `gateway returned a non-advancing non-fungible cursor for ${account} at sv ${stateVersion}`,
        );
      }
      cursor = next;
      if (page + 1 === MAX_NON_FUNGIBLE_PAGES) {
        throw new GatewayError(
          `non-fungible resources of ${account} at sv ${stateVersion} did not end within ${MAX_NON_FUNGIBLE_PAGES} pages`,
        );
      }
    }
  }
  return out;
}

/** One page's reported amount of a wanted collection, as a non-negative safe integer. */
function nonFungibleAmountFromItem(item: Record<string, unknown>, what: string): number {
  const raw = item["amount"];
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      throw new GatewayError(`${what} reports amount ${JSON.stringify(raw)}, not a non-negative integer`);
    }
    return raw;
  }
  const vaults = asObject(item["vaults"]);
  const items = vaults["items"];
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const vault of items) {
    const count = asObject(vault)["total_count"];
    if (count === undefined || count === null) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new GatewayError(`${what} reports total_count ${JSON.stringify(count)}, not a non-negative integer`);
    }
    total += count;
    if (!Number.isSafeInteger(total)) {
      throw new GatewayError(`${what} amounts overflow the safe integer range`);
    }
  }
  return total;
}

/**
 * HOW MANY non-fungibles of each wanted resource each account held at the snapshot, read from
 * the collection listing at Global aggregation.
 *
 * The Membership weight function is "did the account hold at least one", and a collection's
 * own `amount` is reported without any opt-in. The local-id walk is deliberately not used:
 * its ids exist only because of `non_fungible_include_nfids`, and a Gateway that silently stops
 * honouring that opt-in would return no ids and no error — every member would weigh zero and
 * the whole space would settle Reject with nothing to show for it. A vault-aggregated page (a
 * Gateway that ignored `aggregation_level`) reports per-vault `total_count` instead; both
 * shapes are read so the count never silently becomes zero. Ids are never consulted.
 *
 * Fails closed on a non-advancing cursor, a page overflow, and an amount that is not a
 * non-negative safe integer.
 */
export async function fetchNonFungibleAmountsAt(
  gw: GatewayClient,
  accounts: string[],
  wanted: Set<string>,
  stateVersion: number,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (wanted.size === 0) return out;
  for (const account of accounts) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_NON_FUNGIBLE_PAGES; page++) {
      const resp = asObject(await gw.entityNonFungiblesAmountsPage(account, cursor, stateVersion));
      const message = asString(resp["message"]);
      if (message !== null) {
        throw new GatewayError(
          `gateway refused non-fungible amounts of ${account} at sv ${stateVersion}: ${message}`,
        );
      }
      const items = resp["items"];
      if (!Array.isArray(items)) {
        throw new GatewayError(
          `gateway answered non-fungible amounts of ${account} at sv ${stateVersion} without items`,
        );
      }
      for (const item of items) {
        const o = asObject(item);
        const resource = asString(o["resource_address"]);
        if (resource === null || !wanted.has(resource)) continue;
        const amount = nonFungibleAmountFromItem(o, `non-fungible amounts of ${account} at sv ${stateVersion}`);
        let byResource = out.get(account);
        if (byResource === undefined) {
          byResource = new Map<string, number>();
          out.set(account, byResource);
        }
        const sum = (byResource.get(resource) ?? 0) + amount;
        if (!Number.isSafeInteger(sum)) {
          throw new GatewayError(
            `non-fungible amounts of ${resource} for ${account} at sv ${stateVersion} overflow the safe integer range`,
          );
        }
        byResource.set(resource, sum);
      }
      const next = asString(resp["next_cursor"]);
      if (next === null) break;
      if (next === cursor) {
        throw new GatewayError(
          `gateway returned a non-advancing non-fungible amounts cursor for ${account} at sv ${stateVersion}`,
        );
      }
      cursor = next;
      if (page + 1 === MAX_NON_FUNGIBLE_PAGES) {
        throw new GatewayError(
          `non-fungible amounts of ${account} at sv ${stateVersion} did not end within ` +
            `${MAX_NON_FUNGIBLE_PAGES} pages`,
        );
      }
    }
  }
  return out;
}

/**
 * The data of named position ids, at the snapshot. Returns only ids that HAVE data there; a
 * burned position has none and contributes zero.
 */
export async function fetchPositionDataAt(
  gw: GatewayClient,
  resource: string,
  ids: string[],
  stateVersion: number,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (let i = 0; i < ids.length; i += NON_FUNGIBLE_DATA_CHUNK) {
    const chunk = ids.slice(i, i + NON_FUNGIBLE_DATA_CHUNK);
    const resp = asObject(await gw.nonFungibleData(resource, chunk, stateVersion));
    const message = asString(resp["message"]);
    if (message !== null) {
      throw new GatewayError(
        `gateway refused non-fungible data of ${resource} at sv ${stateVersion}: ${message}`,
      );
    }
    for (const item of asArray(resp["non_fungible_ids"])) {
      const o = asObject(item);
      const id = asString(o["non_fungible_id"]);
      if (id === null) continue;
      const data = asObject(o["data"])["programmatic_json"];
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        out.set(id, data);
      }
    }
  }
  return out;
}
