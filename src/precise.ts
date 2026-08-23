/**
 * Scrypto `PreciseDecimal` arithmetic — the 36-decimal fixed point the concentrated-liquidity
 * legs are evaluated in (tally document v17).
 *
 * This exists as a separate type rather than a wider `Dec` because the two scales are NOT
 * interchangeable in the rule: `Decimal` (18 places, I192) is what every weight, total and
 * threshold in a tally document is, and `PreciseDecimal` (36 places, I256) is what the tick
 * power and the removable-amount formula are evaluated in before being narrowed back down. A
 * port that did the tick arithmetic at 18 places would land on different digits and hash to a
 * different document.
 *
 * Every operation truncates toward zero, and every intermediate is range-checked exactly where
 * the reference implementation checks it. `null` is this file's `Option::None`: scrypto's
 * `checked_*` family returns `None` on overflow and the weight rule turns that into a REFUSAL,
 * never into a clamp or a zero — a clamped price values a position wrongly instead of loudly.
 *
 * No float appears here, and none may be introduced. These values carry 36 digits after the
 * point; an IEEE-754 double carries about 15-16 significant digits in total.
 */

export const PRECISE_DECIMAL_PLACES = 36n;
export const PRECISE_ONE = 10n ** PRECISE_DECIMAL_PLACES;

/** I256 bounds — `PreciseDecimal`'s backing integer. Scrypto rejects values outside these. */
const I256_MAX = (1n << 255n) - 1n;
const I256_MIN = -(1n << 255n);

function inRange(sub: bigint): boolean {
  return sub <= I256_MAX && sub >= I256_MIN;
}

/** Integer division truncating toward ZERO — BigInt `/` already does, said out loud. */
function truncDiv(a: bigint, b: bigint): bigint {
  return a / b;
}

export class PDec {
  /** Value in subunits (10^-36). The only state. */
  readonly sub: bigint;

  private constructor(sub: bigint) {
    this.sub = sub;
  }

  static readonly ZERO = new PDec(0n);
  static readonly ONE = new PDec(PRECISE_ONE);

  /** `null` when the value does not fit I256, mirroring scrypto's `I256::try_from(..).ok()?`. */
  static fromSubunits(sub: bigint): PDec | null {
    return inRange(sub) ? new PDec(sub) : null;
  }

  /**
   * Parse the canonical string form. Strict for the same reason `Dec.parse` is: a verifier that
   * quietly accepts an exponent has accepted an input that did not come from where the caller
   * thinks it did.
   */
  static parse(s: string): PDec {
    if (typeof s !== "string") {
      throw new TypeError(`PreciseDecimal must be a string, got ${typeof s}`);
    }
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) {
      throw new SyntaxError(
        `not a canonical PreciseDecimal: ${JSON.stringify(s)} ` +
          `(expected an optional '-', digits, and at most ${PRECISE_DECIMAL_PLACES} decimal places)`,
      );
    }
    const [, sign, whole, frac = ""] = m;
    if (BigInt(frac.length) > PRECISE_DECIMAL_PLACES) {
      throw new SyntaxError(
        `PreciseDecimal has ${frac.length} decimal places, the representation carries ` +
          `${PRECISE_DECIMAL_PLACES}: ${s}`,
      );
    }
    const scaled = BigInt(
      (whole as string) + frac.padEnd(Number(PRECISE_DECIMAL_PLACES), "0"),
    );
    const sub = sign === "-" ? -scaled : scaled;
    if (!inRange(sub)) throw new RangeError(`PreciseDecimal out of I256 range: ${s}`);
    return new PDec(sub);
  }

  /** Minimal canonical form, exactly as `Dec.toString()` does at 18 places. */
  toString(): string {
    const neg = this.sub < 0n;
    const abs = neg ? -this.sub : this.sub;
    const whole = abs / PRECISE_ONE;
    const frac = abs % PRECISE_ONE;
    if (frac === 0n) return `${neg ? "-" : ""}${whole}`;
    const fracStr = frac
      .toString()
      .padStart(Number(PRECISE_DECIMAL_PLACES), "0")
      .replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole}.${fracStr}`;
  }

  add(o: PDec): PDec | null {
    return PDec.fromSubunits(this.sub + o.sub);
  }

  subtract(o: PDec): PDec | null {
    return PDec.fromSubunits(this.sub - o.sub);
  }

  /** `(a * b) / 10^36`, truncating toward zero — scrypto computes this in I384 and narrows. */
  mul(o: PDec): PDec | null {
    return PDec.fromSubunits(truncDiv(this.sub * o.sub, PRECISE_ONE));
  }

  /** `(a * 10^36) / b`, truncating toward zero. Division by zero is `None`, not a throw. */
  div(o: PDec): PDec | null {
    if (o.sub === 0n) return null;
    return PDec.fromSubunits(truncDiv(this.sub * PRECISE_ONE, o.sub));
  }

  /**
   * Exponentiation by squaring, TRUNCATING after every multiplication — the algorithm
   * `WEIGHT_RULE` publishes, mirroring `PreciseDecimal::checked_powi` step for step.
   *
   * The negative branch is the one worth reading twice. Scrypto computes the reciprocal FIRST,
   * truncated to 36 places, and raises that: `S(-t) = (1/base)^t`, not `1/(base^t)`. The two
   * differ in the last places, and the rule's own text says which one it means ("one divided by
   * the base (truncated to the same 36 decimals) raised to the power -t"). A port that inverted
   * at the end would disagree with the ledger on every below-range position.
   */
  powi(exp: bigint): PDec | null {
    if (exp < 0n) {
      // `(ONE * ONE) / base` — the reciprocal, at the same 36 places.
      if (this.sub === 0n) return null;
      const recip = PDec.fromSubunits(truncDiv(PRECISE_ONE * PRECISE_ONE, this.sub));
      if (recip === null) return null;
      return recip.powi(-exp);
    }
    if (exp === 0n) return PDec.ONE;
    if (exp === 1n) return this;
    const squared = PDec.fromSubunits(truncDiv(this.sub * this.sub, PRECISE_ONE));
    if (squared === null) return null;
    if (exp % 2n === 0n) return squared.powi(exp / 2n);
    const rest = squared.powi((exp - 1n) / 2n);
    if (rest === null) return null;
    return this.mul(rest);
  }

  cmp(o: PDec): -1 | 0 | 1 {
    return this.sub < o.sub ? -1 : this.sub > o.sub ? 1 : 0;
  }
  eq(o: PDec): boolean {
    return this.sub === o.sub;
  }
  lt(o: PDec): boolean {
    return this.sub < o.sub;
  }
  lte(o: PDec): boolean {
    return this.sub <= o.sub;
  }
  gt(o: PDec): boolean {
    return this.sub > o.sub;
  }
  gte(o: PDec): boolean {
    return this.sub >= o.sub;
  }
  isZero(): boolean {
    return this.sub === 0n;
  }
  isPositive(): boolean {
    return this.sub > 0n;
  }
  isNegative(): boolean {
    return this.sub < 0n;
  }
}
