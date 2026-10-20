/**
 * Radix address classification, from the first byte of the address payload.
 *
 * A Radix address is bech32: a human-readable part naming the network, then five-bit data
 * values. The first two values carry the entity-type byte — five bits in the first, the
 * remaining three in the high bits of the second — and the last six values are the checksum.
 * Only the entity type is wanted here, so the checksum is not verified: a malformed address
 * simply classifies as neither a preallocated nor an allocated account, and the caller's
 * entity-details rule then has nothing to require of it.
 *
 * The two account types matter because the Gateway treats them differently at a historical
 * state version. A PREALLOCATED account is a virtual entity that exists at every state
 * version, even before it is first touched, so a details answer that leaves it out did not
 * answer the state that was asked for. An ALLOCATED account exists only from the transaction
 * that created it, so one created after the snapshot is legitimately absent and weighs zero.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** `GlobalPreallocatedSecp256k1Account`. */
const PREALLOCATED_SECP256K1 = 0x02;
/** `GlobalPreallocatedEd25519Account`. */
const PREALLOCATED_ED25519 = 0x03;
/** `GlobalAccount` — an account allocated by a transaction, not a virtual one. */
const ALLOCATED_ACCOUNT = 0xc1;

const ENTITY_TYPE: ReadonlyMap<number, string> = new Map([
  [PREALLOCATED_SECP256K1, "preallocated"],
  [PREALLOCATED_ED25519, "preallocated"],
  [ALLOCATED_ACCOUNT, "allocated"],
]);

/**
 * The entity-type byte of a bech32 address, or `null` when the string is not a bech32 address
 * with at least the two data values the byte needs. Case and checksum are not inspected —
 * see the module comment.
 */
export function addressEntityType(address: string): number | null {
  const lower = address.toLowerCase();
  const separator = lower.lastIndexOf("1");
  if (separator <= 0 || separator + 1 >= lower.length) return null;
  let high = -1;
  let low = 0;
  let seen = 0;
  for (let i = separator + 1; i < lower.length && seen < 2; i++, seen++) {
    const value = CHARSET.indexOf(lower[i] as string);
    if (value < 0) return null;
    if (seen === 0) high = value;
    else low = value;
  }
  if (seen < 2 || high < 0) return null;
  return (high << 3) | (low >> 2);
}

function isAccountOfType(address: string, kind: string): boolean {
  const type = addressEntityType(address);
  return type !== null && ENTITY_TYPE.get(type) === kind;
}

/** A preallocated (virtual) account, which the Gateway reports at every state version. */
export function isPreallocatedAccount(address: string): boolean {
  return isAccountOfType(address, "preallocated");
}

/** An account allocated by a transaction, absent from states before that transaction. */
export function isAllocatedAccount(address: string): boolean {
  return isAccountOfType(address, "allocated");
}
