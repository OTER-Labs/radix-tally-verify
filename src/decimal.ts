/**
 * Scrypto `Decimal` arithmetic, reimplemented from the specification rather than ported.
 *
 * This is the part of an independent verifier that is easiest to get subtly wrong and hardest to
 * notice: every weight, quorum and threshold in a tally document is a scrypto `Decimal`, and a
 * verifier whose arithmetic differs in the eighteenth decimal place computes a different hash from
 * identical content and reports a lie that isn't there.
 *
 * The representation is a signed 192-bit integer counting units of 10^-18. There is no float
 * anywhere in this file, and there must never be: an IEEE-754 double carries about 15-16 significant
 * decimal digits, and these values carry up to 18 after the point alone.
 *
 * Division and multiplication TRUNCATE toward zero. They do not round. That is the single most
 * consequential rule here — `1/3` is `0.333333333333333333`, not `...334`, and a verifier that
 * rounds disagrees with the ledger on any consultation where a division happened.
 */

export const DECIMAL_PLACES = 18n;
export const ONE_SUBUNIT = 10n ** DECIMAL_PLACES;

/** I192 bounds. Scrypto rejects values outside these; so do we, rather than wrapping silently. */
const I192_MAX = (1n << 191n) - 1n;
const I192_MIN = -(1n << 191n);

export class Dec {
  /** Value in subunits (10^-18). The only state. */
  readonly sub: bigint;

  private constructor(sub: bigint) {
    if (sub > I192_MAX || sub < I192_MIN) {
      throw new RangeError(`Decimal out of I192 range: ${sub}`);
    }
    this.sub = sub;
  }

  static readonly ZERO = new Dec(0n);
  static readonly ONE = new Dec(ONE_SUBUNIT);

  static fromSubunits(sub: bigint): Dec {
    return new Dec(sub);
  }

  static fromInt(n: bigint | number): Dec {
    return new Dec(BigInt(n) * ONE_SUBUNIT);
  }

  /**
   * Parse the canonical string form — what `Decimal::to_string()` emits and what every numeric
   * field of a tally document contains.
   *
   * Deliberately strict. A verifier that quietly accepts `1e18`, `1_000`, `+5` or a value with 19
   * decimal places is a verifier that will one day accept a malformed document and hash it to
   * something plausible. Exponents in particular are refused rather than interpreted: scrypto never
   * emits them, so their presence means the input did not come from where the caller thinks.
   */
  static parse(s: string): Dec {
    if (typeof s !== "string") {
      throw new TypeError(`Decimal must be a string, got ${typeof s}`);
    }
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) {
      throw new SyntaxError(
        `not a canonical Decimal: ${JSON.stringify(s)} ` +
          `(expected an optional '-', digits, and at most ${DECIMAL_PLACES} decimal places; ` +
          `exponents and separators are not part of the form scrypto emits)`,
      );
    }
    const [, sign, whole, frac = ""] = m;
    if (BigInt(frac.length) > DECIMAL_PLACES) {
      throw new SyntaxError(
        `Decimal has ${frac.length} decimal places, the representation carries ${DECIMAL_PLACES}: ${s}`,
      );
    }
    const scaled = BigInt(whole + frac.padEnd(Number(DECIMAL_PLACES), "0"));
    return new Dec(sign === "-" ? -scaled : scaled);
  }

  /**
   * The canonical string form: minimal, no trailing zeros, no exponent, no decimal point when there
   * is no fractional part. `10`, not `10.000000000000000000` — see the serialization spec §3.3.
   * A verifier that pads produces different bytes and therefore a different hash.
   */
  toString(): string {
    const neg = this.sub < 0n;
    const abs = neg ? -this.sub : this.sub;
    const whole = abs / ONE_SUBUNIT;
    const frac = abs % ONE_SUBUNIT;
    if (frac === 0n) return `${neg ? "-" : ""}${whole}`;
    const fracStr = frac.toString().padStart(Number(DECIMAL_PLACES), "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole}.${fracStr}`;
  }

  add(o: Dec): Dec {
    return new Dec(this.sub + o.sub);
  }

  sub_(o: Dec): Dec {
    return new Dec(this.sub - o.sub);
  }

  /** Truncating toward zero, per scrypto. `a * b` is `(a.sub * b.sub) / 10^18`. */
  mul(o: Dec): Dec {
    return new Dec(truncDiv(this.sub * o.sub, ONE_SUBUNIT));
  }

  /** Truncating toward zero, per scrypto. `a / b` is `(a.sub * 10^18) / b.sub`. */
  div(o: Dec): Dec {
    if (o.sub === 0n) throw new RangeError("Decimal division by zero");
    return new Dec(truncDiv(this.sub * ONE_SUBUNIT, o.sub));
  }

  /**
   * Narrow a 36-place `PreciseDecimal` subunit count to this 18-place representation,
   * truncating toward zero — scrypto's `Decimal::try_from(PreciseDecimal)`, which is
   * `checked_truncate(RoundingMode::ToZero)`.
   *
   * `null` rather than a throw when the value does not fit I192: the concentrated-liquidity
   * legs turn that into a named refusal ("does not fit the tally's Decimal scale"), because a
   * position whose value overflows the tally's own scale is not a position worth its maximum.
   */
  static fromPreciseSubunits(preciseSub: bigint, preciseScale: bigint): Dec | null {
    const divisor = 10n ** (preciseScale - DECIMAL_PLACES);
    const sub = truncDiv(preciseSub, divisor);
    return sub > I192_MAX || sub < I192_MIN ? null : new Dec(sub);
  }

  /**
   * Truncate toward zero to `places` decimal places — scrypto's
   * `checked_round(places, RoundingMode::ToZero)`.
   *
   * Used only by the concentrated-liquidity legs, to reduce a computed token amount to the
   * amount that would actually be withdrawn at that resource's divisibility. `places >= 18`
   * leaves the value alone, since 18 is the whole representation.
   */
  truncateToPlaces(places: number): Dec {
    if (!Number.isInteger(places) || places < 0) {
      throw new RangeError(`decimal places must be a non-negative integer, got ${places}`);
    }
    if (BigInt(places) >= DECIMAL_PLACES) return this;
    const divisor = 10n ** (DECIMAL_PLACES - BigInt(places));
    // JavaScript's `%` on BigInt is the C-style remainder (sign follows the dividend), which is
    // exactly what scrypto's ToZero strategy resolves to in both directions.
    return new Dec(this.sub - (this.sub % divisor));
  }

  cmp(o: Dec): -1 | 0 | 1 {
    return this.sub < o.sub ? -1 : this.sub > o.sub ? 1 : 0;
  }

  eq(o: Dec): boolean {
    return this.sub === o.sub;
  }
  lt(o: Dec): boolean {
    return this.sub < o.sub;
  }
  lte(o: Dec): boolean {
    return this.sub <= o.sub;
  }
  gt(o: Dec): boolean {
    return this.sub > o.sub;
  }
  gte(o: Dec): boolean {
    return this.sub >= o.sub;
  }
  isZero(): boolean {
    return this.sub === 0n;
  }
  isPositive(): boolean {
    return this.sub > 0n;
  }
}

/**
 * Integer division truncating toward ZERO.
 *
 * BigInt `/` already truncates toward zero in JavaScript, unlike Python's `//` which floors. This
 * function exists to say so out loud: the difference only shows on negative operands, which a tally
 * currently never produces, and a silent dependence on a language quirk is exactly the kind of thing
 * that breaks when someone ports this file to a language that floors.
 */
export function truncDiv(a: bigint, b: bigint): bigint {
  return a / b;
}

export function sum(values: Iterable<Dec>): Dec {
  let acc = Dec.ZERO;
  for (const v of values) acc = acc.add(v);
  return acc;
}
