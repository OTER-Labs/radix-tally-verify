/**
 * The two CONCENTRATED-LIQUIDITY legs (tally document v17).
 *
 * The numbers pinned here are not this package's own output. The mainnet position vector and the
 * shape-pool claim figures are the ones the reference implementation pins in its own test suite,
 * and the point of restating them in a second language is the same as the golden vector's: two
 * implementations that agree on them turn the published `weight_rule` text into a specification
 * rather than a description of one codebase's arithmetic.
 *
 * If one of these fails, do not adjust the constant. Establish which implementation departed
 * from the rule first.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  TICK_BASE_SQRT,
  WeightRuleError,
  floorToDivisibility,
  parseBinEntry,
  parseLiquidityClaims,
  parseLiquidityPosition,
  poolTokenPair,
  precisionPositionXrd,
  quantaCurrentTick,
  removableAmounts,
  shapeClaimsXrd,
  tickPriceSqrt,
  verifyNamedPool,
} from "../src/concentrated.ts";
import type { PrecisionPool, ShapePool } from "../src/concentrated.ts";
import { Dec } from "../src/decimal.ts";
import { PDec } from "../src/precise.ts";

const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
const OCI = "resource_rdx1t52pvtk5wfhltchwh3rkzls2x0r98fw9cjhpyrf3vsykhkuwrf7jg8";
const PRECISION_COMPONENT = "component_rdx1cp0precision0000000000000000000000000000000000000001";
const PRECISION_LP = "resource_rdx1n0precisionlp0000000000000000000000000000000000000002";
const SHAPE_COMPONENT = "component_rdx1cp0shape000000000000000000000000000000000000000000003";
const SHAPE_RECEIPT = "resource_rdx1n0shapereceipt00000000000000000000000000000000000004";
const X_VAULT = "internal_vault_rdx1x0000000000000000000000000000000000000000000000005";
const Y_VAULT = "internal_vault_rdx1y0000000000000000000000000000000000000000000000006";

const dec = (s: string): Dec => Dec.parse(s);

/** XRD at par, everything else worth nothing — the rule's "any other resource at zero". */
const xrdOnly = (resource: string, amount: Dec): Dec => (resource === XRD ? amount : Dec.ZERO);
/** Everything at par, to show which leg a filter is actually discarding. */
const everythingAtPar = (_resource: string, amount: Dec): Dec => amount;
const eighteen = (): number | null => 18;

function precisionPool(): PrecisionPool {
  return {
    component: PRECISION_COMPONENT,
    positionResource: PRECISION_LP,
    tokenX: OCI,
    tokenY: XRD,
    priceSqrt: PDec.parse("0.847502416631256480901344166758536566"),
  };
}

/* ---- the tick power ------------------------------------------------------- */

test("the tick power follows the published base and algorithm", () => {
  const base = PDec.parse(TICK_BASE_SQRT);
  assert.equal(tickPriceSqrt(0)?.toString(), PDec.ONE.toString(), "S(0) is exactly one");
  assert.equal(tickPriceSqrt(1)?.toString(), base.toString(), "S(1) is exactly the base");

  // A tick and its negation are reciprocals, up to the truncation the algorithm states. This is
  // the property that would break first if the negative branch inverted at the END instead of
  // computing the reciprocal first.
  const up = tickPriceSqrt(7260) as PDec;
  const down = tickPriceSqrt(-7260) as PDec;
  const product = up.mul(down) as PDec;
  const drift = product.subtract(PDec.ONE) as PDec;
  const bound = PDec.parse("0.000000000000000001");
  assert.ok(
    (drift.isNegative() ? (PDec.ZERO.subtract(drift) as PDec) : drift).lt(bound),
    `S(t)*S(-t) drifted from 1 by ${drift.toString()}`,
  );

  // Monotone in the tick, which is what makes the three-branch comparison meaningful at all.
  assert.ok((tickPriceSqrt(-6540) as PDec).lt(tickPriceSqrt(7260) as PDec));
});

test("the tick power truncates rather than rounding, at 36 places", () => {
  // Squaring the base once is the first step of the algorithm, and it is where a rounding
  // implementation would already differ in the last place.
  const base = PDec.parse(TICK_BASE_SQRT);
  const squared = tickPriceSqrt(2) as PDec;
  const bySub = PDec.fromSubunits((base.sub * base.sub) / 10n ** 36n) as PDec;
  assert.equal(squared.toString(), bySub.toString(), "truncating, not rounding, after the multiply");
});

/* ---- the precision leg ---------------------------------------------------- */

/**
 * A REAL mainnet position, valued end to end: Ociswap V2 OCI/XRD position `#1#` at state version
 * 546,000,000. The position straddles the pool price, so it holds both legs; only the XRD leg is
 * credited, because the rule does not recognise OCI — exactly as an unrecognised token is
 * treated everywhere else.
 */
test("a live mainnet precision position values to its pinned figure", () => {
  const pool = precisionPool();
  const position = {
    liquidity: PDec.parse("2016.738774772895807708564745848344742595"),
    leftBound: -6540,
    rightBound: 7260,
  };
  const value = precisionPositionXrd(position, pool, eighteen, xrdOnly);
  // EXACT, to the last of the tally's eighteen places. Not "close enough" — this number is hashed
  // into a document someone bonds on, so a port that agreed only approximately would make an
  // honest challenger read as a liar.
  assert.equal(value.toString(), "254.929665520653811333");

  // And the x leg really is discarded: with OCI recognised at par the answer is ~1231 rather
  // than ~255, so the filter is doing work rather than decoration.
  const both = precisionPositionXrd(position, pool, eighteen, everythingAtPar);
  assert.ok(both.gt(value.add(dec("900"))), `both legs at par should exceed 900 more: ${both}`);
});

test("a precision position holds exactly one token when its range misses the price", () => {
  const pool = precisionPool();
  // The pool's price_sqrt sits at tick about -3310, so neither range below straddles it.

  // Entirely ABOVE the price: not yet reached by the market, so wholly in token_x, which here is
  // OCI. The rule does not recognise OCI, so a MILLION units of liquidity parked out of reach
  // carries no weight at all. That is the farming surface the branch exists to close.
  const above = { liquidity: PDec.parse("1000000"), leftBound: 1000, rightBound: 2000 };
  const [ax, ay] = removableAmounts(
    above.liquidity,
    pool.priceSqrt,
    tickPriceSqrt(above.leftBound) as PDec,
    tickPriceSqrt(above.rightBound) as PDec,
  ) as [PDec, PDec];
  assert.ok(ax.isPositive(), "an above-range position is wholly in token_x");
  assert.ok(ay.isZero(), "an above-range position holds no y");
  assert.equal(
    precisionPositionXrd(above, pool, eighteen, xrdOnly).toString(),
    "0",
    "liquidity parked out of reach on the non-XRD side is not weight",
  );

  // Entirely BELOW the price: traded through, so wholly in token_y, which here IS XRD.
  const below = { liquidity: PDec.parse("1000"), leftBound: -8000, rightBound: -7000 };
  const [bx, by] = removableAmounts(
    below.liquidity,
    pool.priceSqrt,
    tickPriceSqrt(below.leftBound) as PDec,
    tickPriceSqrt(below.rightBound) as PDec,
  ) as [PDec, PDec];
  assert.ok(bx.isZero(), "a below-range position holds no x");
  assert.ok(by.isPositive(), "a below-range position is wholly in token_y");
  assert.ok(
    precisionPositionXrd(below, pool, eighteen, xrdOnly).isPositive(),
    "and that one does carry weight, because token_y is XRD",
  );
});

test("a degenerate range and non-positive liquidity hold nothing", () => {
  const pool = precisionPool();
  assert.equal(
    precisionPositionXrd(
      { liquidity: PDec.parse("0"), leftBound: -100, rightBound: 100 },
      pool,
      eighteen,
      everythingAtPar,
    ).toString(),
    "0",
    "no liquidity, no principal",
  );
  // An INVERTED range (right at or below left) holds nothing rather than a negative amount.
  const [x, y] = removableAmounts(
    PDec.parse("1000"),
    pool.priceSqrt,
    tickPriceSqrt(100) as PDec,
    tickPriceSqrt(-100) as PDec,
  ) as [PDec, PDec];
  assert.ok(x.isZero() && y.isZero(), "an inverted range holds nothing");
});

test("a computed amount is truncated to its own resource's divisibility", () => {
  // An unreported divisibility leaves the amount at the tally's own 18 places.
  assert.equal(
    floorToDivisibility(dec("1.123456789012345678"), null).toString(),
    "1.123456789012345678",
  );
  assert.equal(floorToDivisibility(dec("1.123456789012345678"), 6).toString(), "1.123456");
  assert.equal(floorToDivisibility(dec("1.123456789012345678"), 0).toString(), "1");
  assert.equal(
    floorToDivisibility(dec("1.123456789012345678"), 18).toString(),
    "1.123456789012345678",
    "18 is the whole representation, so it is a no-op",
  );
});

/* ---- the shape leg -------------------------------------------------------- */

function shapePool(): ShapePool {
  // token_x is unrecognised, token_y is XRD, so only the y side scores — the same filter as
  // everywhere else in the rule.
  return {
    component: SHAPE_COMPONENT,
    positionResource: SHAPE_RECEIPT,
    tokenX: OCI,
    tokenY: XRD,
    currentTick: 100,
    activeX: dec("400"),
    activeY: dec("800"),
    activeTotalClaim: dec("1000"),
    bins: new Map<number, [Dec, Dec]>([
      [99, [dec("500"), dec("1000")]],
      [101, [dec("700"), dec("1000")]],
    ]),
  };
}

test("a shape receipt resolves its claims below, at and above the current tick", () => {
  const pool = shapePool();

  // A claim BELOW the current tick redeems in y: 250/1000 of the bin's 500 = 125 XRD.
  const below = new Map([[99, dec("250")]]);
  assert.equal(shapeClaimsXrd(below, pool, xrdOnly).toString(), "125");

  // A claim ABOVE it redeems in x, which is not XRD — so it is worth nothing here...
  const above = new Map([[101, dec("250")]]);
  assert.equal(shapeClaimsXrd(above, pool, xrdOnly).toString(), "0");
  // ...but it IS a real amount of x, which a pool pairing XRD the other way round would credit:
  // 250/1000 of 700 = 175.
  assert.equal(shapeClaimsXrd(above, pool, everythingAtPar).toString(), "175");

  // A claim AT the current tick takes its share of BOTH active reserves: 250/1000 of active_y
  // 800 = 200 XRD, plus 100 of the unrecognised x.
  const at = new Map([[100, dec("250")]]);
  assert.equal(shapeClaimsXrd(at, pool, xrdOnly).toString(), "200");
  assert.equal(shapeClaimsXrd(at, pool, everythingAtPar).toString(), "300");

  // All three together sum, rather than any of them shadowing the others.
  const all = new Map([
    [99, dec("250")],
    [100, dec("250")],
    [101, dec("250")],
  ]);
  assert.equal(shapeClaimsXrd(all, pool, xrdOnly).toString(), "325");
});

test("a shape pool with no current tick is worth nothing, and empty bins are worth zero", () => {
  const pool = { ...shapePool(), currentTick: null };
  const claims = new Map([[99, dec("250")]]);
  assert.equal(
    shapeClaimsXrd(claims, pool, everythingAtPar).toString(),
    "0",
    "without a current tick there is no rule for which side of the book a claim sits on",
  );

  // A tick with no bin entry is worth zero rather than an error: a bin map legitimately omits
  // ticks carrying no liquidity, and the Gateway omits a key that does not exist.
  const live = shapePool();
  assert.equal(shapeClaimsXrd(new Map([[42, dec("250")]]), live, everythingAtPar).toString(), "0");
  // ...and so is a bin nobody has a claim on, which would otherwise be a division by zero.
  const emptyBin: ShapePool = {
    ...live,
    bins: new Map<number, [Dec, Dec]>([[99, [dec("500"), dec("0")]]]),
  };
  assert.equal(
    shapeClaimsXrd(new Map([[99, dec("250")]]), emptyBin, everythingAtPar).toString(),
    "0",
  );
  // Same for the ACTIVE tick with no claims outstanding.
  const noActive: ShapePool = { ...live, activeTotalClaim: dec("0") };
  assert.equal(
    shapeClaimsXrd(new Map([[100, dec("250")]]), noActive, everythingAtPar).toString(),
    "0",
  );
});

/* ---- what admits a named pool --------------------------------------------- */

function precisionItem(blueprint: string, manager: string): Record<string, unknown> {
  return {
    address: PRECISION_COMPONENT,
    details: {
      blueprint_name: blueprint,
      state: {
        fields: [
          { field_name: "lp_manager", value: manager },
          { field_name: "price_sqrt", value: "0.847502416631256480901344166758536566" },
          { field_name: "x_liquidity", value: X_VAULT },
          { field_name: "y_liquidity", value: Y_VAULT },
        ],
      },
    },
    fungible_resources: {
      items: [
        { resource_address: OCI, vaults: { items: [{ vault_address: X_VAULT, amount: "1" }] } },
        { resource_address: XRD, vaults: { items: [{ vault_address: Y_VAULT, amount: "1" }] } },
      ],
    },
  };
}

const backLinks = (entries: Array<[string, string]>): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const [resource, component] of entries) {
    out.set(resource, (out.get(resource) ?? []).concat(component));
  }
  return out;
};

test("a named pool is admitted only by the blueprint AND the two-way link", () => {
  const genuine = backLinks([[PRECISION_LP, PRECISION_COMPONENT]]);
  assert.equal(
    verifyNamedPool(
      precisionItem("PrecisionPool", PRECISION_LP),
      PRECISION_COMPONENT,
      "PrecisionPool",
      "lp_manager",
      genuine,
    ),
    PRECISION_LP,
    "the genuine article verifies",
  );

  // The blueprint is ENGINE state — a component cannot lie about which package's code it runs —
  // so naming something else in this leg is refused rather than read with the wrong field
  // meanings.
  assert.throws(
    () =>
      verifyNamedPool(
        precisionItem("QuantaSwap", PRECISION_LP),
        PRECISION_COMPONENT,
        "PrecisionPool",
        "lp_manager",
        genuine,
      ),
    WeightRuleError,
  );

  // And a position resource that does not name the component back fails independently. Without
  // this, a component could claim any resource's positions as its own.
  assert.throws(
    () =>
      verifyNamedPool(
        precisionItem("PrecisionPool", PRECISION_LP),
        PRECISION_COMPONENT,
        "PrecisionPool",
        "lp_manager",
        backLinks([[PRECISION_LP, "component_rdx1someone_else"]]),
      ),
    WeightRuleError,
  );
});

test("a pool's token pair comes from its vaults, and both Ociswap field namings are accepted", () => {
  // V2 names them x_liquidity/y_liquidity, which is what `precisionItem` writes.
  assert.deepEqual(
    poolTokenPair(
      precisionItem("PrecisionPool", PRECISION_LP),
      PRECISION_COMPONENT,
      ["x_vault", "x_liquidity"],
      ["y_vault", "y_liquidity"],
    ),
    [OCI, XRD],
  );

  // V1 names them x_vault/y_vault. Accepting only one of the two namings silently drops most of
  // the live pools, so both are tried.
  const v1 = precisionItem("PrecisionPool", PRECISION_LP);
  (
    (v1["details"] as Record<string, unknown>)["state"] as Record<string, unknown>
  )["fields"] = [
    { field_name: "lp_manager", value: PRECISION_LP },
    { field_name: "x_vault", value: X_VAULT },
    { field_name: "y_vault", value: Y_VAULT },
  ];
  assert.deepEqual(
    poolTokenPair(v1, PRECISION_COMPONENT, ["x_vault", "x_liquidity"], ["y_vault", "y_liquidity"]),
    [OCI, XRD],
    "the V1 field names resolve to the same pair",
  );

  // A vault whose resource the response does not carry is a refusal, not a guess.
  const orphan = precisionItem("PrecisionPool", PRECISION_LP);
  orphan["fungible_resources"] = { items: [] };
  assert.throws(
    () =>
      poolTokenPair(orphan, PRECISION_COMPONENT, ["x_liquidity"], ["y_liquidity"]),
    WeightRuleError,
  );
});

/* ---- reading the ledger's shapes ------------------------------------------ */

test("position data, claim maps and bin entries parse from their programmatic JSON", () => {
  const position = parseLiquidityPosition({
    fields: [
      { field_name: "liquidity", value: "2016.738774772895807708564745848344742595" },
      { field_name: "left_bound", value: "-6540" },
      { field_name: "right_bound", value: "7260" },
    ],
  });
  assert.equal(position?.leftBound, -6540);
  assert.equal(position?.rightBound, 7260);
  assert.equal(
    position?.liquidity.toString(),
    "2016.738774772895807708564745848344742595",
    "liquidity keeps all 36 places — narrowing it here would lose the position's last digits",
  );
  // A struct that does not carry the three fields is null, which the caller turns into a refusal
  // rather than a zero: a position we cannot read is not a position worth nothing.
  assert.equal(parseLiquidityPosition({ fields: [{ field_name: "liquidity", value: "1" }] }), null);

  const claims = parseLiquidityClaims({
    fields: [
      {
        field_name: "liquidity_claims",
        entries: [
          { key: { value: "99" }, value: { value: "250" } },
          { key: { value: "100" }, value: { value: "1.5" } },
        ],
      },
    ],
  });
  assert.equal(claims?.get(99)?.toString(), "250");
  assert.equal(claims?.get(100)?.toString(), "1.5");
  assert.equal(parseLiquidityClaims({ fields: [] }), null);

  const bin = parseBinEntry({
    key: { programmatic_json: { fields: [{ value: "27210" }] } },
    value: {
      programmatic_json: {
        fields: [
          { field_name: "amount", value: "12.5" },
          { field_name: "total_claim", value: "100" },
        ],
      },
    },
  });
  assert.equal(bin?.[0], 27210);
  assert.equal(bin?.[1][0].toString(), "12.5");
  assert.equal(bin?.[1][1].toString(), "100");
});

test("a QuantaSwap's current tick reads through the Option and the Tick tuple", () => {
  const withTick = {
    details: {
      state: {
        fields: [
          {
            field_name: "tick_index",
            fields: [
              {
                field_name: "current",
                variant_name: "Some",
                fields: [{ fields: [{ value: "27210" }] }],
              },
            ],
          },
        ],
      },
    },
  };
  assert.equal(quantaCurrentTick(withTick), 27210);

  const none = JSON.parse(JSON.stringify(withTick)) as typeof withTick;
  (
    none.details.state.fields[0] as unknown as { fields: Array<{ variant_name: string }> }
  ).fields[0]!.variant_name = "None";
  assert.equal(quantaCurrentTick(none), null, "a pool with no active tick reports none");
});
