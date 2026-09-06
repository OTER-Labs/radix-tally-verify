/**
 * Canonical JSON serialization and the tally hash.
 *
 * Implements the published canonical-serialization specification from its TEXT, not by copying
 * the reference implementation. That is the whole point of this package: if the two agree, the
 * spec is a standard; if only one exists, the spec is a description of that one's behaviour.
 *
 * The four rules, restated so this file can be read on its own:
 *   1. no insignificant whitespace
 *   2. object keys ascending by UTF-8 byte sequence, at every level
 *   3. every quantity that is not a small integer is a JSON STRING (see decimal.ts)
 *   4. arrays keep their order — it is content, never sorted
 */

import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex } from "@noble/hashes/utils";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Sort object keys by UTF-8 BYTE sequence.
 *
 * Not `Array.prototype.sort()`'s default, which orders by UTF-16 code unit. The two disagree above
 * U+FFFF: a key containing an astral character (an emoji in a consultation title, say) sorts
 * differently under each, and the resulting documents hash differently while looking identical.
 * Every key in a tally document is ASCII today, where all three orderings coincide — this is here
 * so that stays true by construction rather than by luck.
 *
 * Exported because it is not only the key order: `excluded_accounts` is specified as an array
 * sorted ascending by the same UTF-8 byte order, and a second comparator written for that would
 * be a second chance to get it wrong.
 */
export function compareUtf8(a: string, b: string): number {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    // Both indices are < n <= each length, so these are always present; the locals are for the
    // type checker under noUncheckedIndexedAccess, not a real absence.
    const x = ba[i] as number;
    const y = bb[i] as number;
    if (x !== y) return x - y;
  }
  return ba.length - bb.length;
}

/**
 * Serialize to the canonical form.
 *
 * Numbers are emitted only when they are safe integers. A non-integer JSON number in a tally
 * document is a bug in whatever produced it — every real quantity is a Decimal string — and
 * emitting it would mean choosing a float formatting, which is precisely the ambiguity this format
 * exists to remove. So it throws instead of guessing.
 */
export function canonicalize(value: Json): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      if (!Number.isInteger(value)) {
        throw new TypeError(
          `non-integer JSON number ${value} in a canonical document — every quantity that is not a ` +
            `small integer must be a Decimal STRING (spec §3.3). A float here would make the ` +
            `encoding depend on a formatting choice.`,
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(`integer ${value} exceeds the safe range and would lose precision`);
      }
      return String(value);

    case "string":
      return JSON.stringify(value);

    case "object":
      break;

    default:
      throw new TypeError(`cannot canonicalize a ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const obj = value as { [k: string]: Json };
  const keys = Object.keys(obj).sort(compareUtf8);
  const parts = keys.map((k) => {
    const v = obj[k];
    if (v === undefined) {
      // `undefined` is not JSON. In the Rust it cannot arise; here it would silently vanish from
      // the output and move the hash, so refuse it rather than drop it.
      throw new TypeError(`key ${JSON.stringify(k)} is undefined — use null for an absent value`);
    }
    return `${JSON.stringify(k)}:${canonicalize(v)}`;
  });
  return `{${parts.join(",")}}`;
}

/** blake2b-256, no key/salt/personalisation — the same primitive Radix uses. Lowercase hex. */
export function tallyHash(document: Json): string {
  const bytes = new TextEncoder().encode(canonicalize(document));
  return bytesToHex(blake2b(bytes, { dkLen: 32 }));
}
