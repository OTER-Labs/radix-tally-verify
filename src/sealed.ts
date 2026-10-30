/**
 * The sealed ballot core, mirroring the registry engine's `sealed.rs` (Task 8) token for token:
 * the round arithmetic of spec §1, the drand quicknet signature check, the tlock age file opened
 * with the round's file key, and the four-line plaintext's validity rules (spec §6.3).
 *
 * Decryption runs through `tlock-js`, the same library the frontend seals with, bundled at
 * install time (see `scripts/build-tlock.mjs`) because the fork ships TypeScript source only and
 * node's type-stripping refuses files under `node_modules`. The bundle is imported lazily through
 * the package's `#tlock` subpath so the verifier's own modules stay plain erasable TypeScript.
 *
 * One thing differs from `sealed.rs` only because it is not this layer's to decide:
 * `sealingRound` throws when the vote ends before the drand chain began. The contract panics on
 * the same condition; a verifier meeting it in a document reports it as a difference, not as a
 * crash.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

/** drand quicknet, pinned for every layer (spec §1). */
export interface SealedChain {
  chainHash: string;
  publicKey: string;
  genesisTime: number;
  periodSeconds: number;
}

export const QUICKNET_CHAIN: SealedChain = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesisTime: 1692803367,
  periodSeconds: 3,
};

/** The first line of every sealed ballot's plaintext. */
export const SEALED_PLAINTEXT_TAG = "oter-sealed-ballot-v1";

/** The five invalid reasons, exactly the tokens the engine serialises. */
export type SealedInvalid =
  | "undecryptable"
  | "wrong_round"
  | "malformed"
  | "wrong_vote"
  | "invalid_selection";

export const SEALED_INVALID_REASONS: readonly SealedInvalid[] = [
  "undecryptable",
  "wrong_round",
  "malformed",
  "wrong_vote",
  "invalid_selection",
];

/** A round and the wall-clock second its signature is published at. */
export interface SealingRound {
  round: number;
  roundTime: number;
}

/**
 * `T = vote_end + margin`, `round = floor((T - genesis) / period) + 1`,
 * `round_time = genesis + (round - 1) * period` (spec §1). Integer arithmetic on seconds, the
 * same as `roundAt` in tlock-js and `sealing_round` in the contract.
 */
export function sealingRound(
  voteEnd: number,
  marginSeconds: number,
  chain: SealedChain,
): SealingRound {
  const t = voteEnd + marginSeconds;
  if (!Number.isSafeInteger(t)) {
    throw new Error(`the vote end and margin (${voteEnd} + ${marginSeconds}) are not whole seconds`);
  }
  if (t <= chain.genesisTime) {
    throw new Error("the vote ends before the drand chain began");
  }
  const round = Math.floor((t - chain.genesisTime) / chain.periodSeconds) + 1;
  return { round, roundTime: chain.genesisTime + (round - 1) * chain.periodSeconds };
}

/* ------------------------------------------------------------------------------------------
 * The tlock-js bundle.
 * ---------------------------------------------------------------------------------------- */

interface Stanza {
  type: string;
  args: string[];
  body: Uint8Array;
}

interface DecodedAge {
  header: { version: string; recipients: Stanza[]; mac: Uint8Array };
  body: Uint8Array;
}

interface IbeCiphertext {
  U: Uint8Array;
  V: Uint8Array;
  W: Uint8Array;
}

interface TlockBundle {
  decodeArmor(armor: string): string;
  isProbablyArmored(input: string): boolean;
  readAge(input: string): DecodedAge;
  decryptAge(payload: string, unwrapFileKey: (recipients: Stanza[]) => Promise<Uint8Array>): Promise<Uint8Array>;
  ibe: { decryptOnG2(key: Uint8Array, ciphertext: IbeCiphertext): Promise<Uint8Array> };
  bls12_381: { G2: { ProjectivePoint: { BASE: { toRawBytes(compressed?: boolean): Uint8Array } } } };
  verifyBeacon(chainInfo: unknown, beacon: unknown, expectedRound: number): Promise<boolean>;
}

const require = createRequire(import.meta.url);
let bundle: TlockBundle | null = null;

/** `#tlock` is the esbuild bundle of `tlock-js` (package.json `imports`), built by
 * `npm run build:tlock`. Loaded on first use so `--hash-only`, the parser and every open-vote
 * path do not pay for it. */
function tlock(): TlockBundle {
  if (bundle === null) bundle = require("#tlock") as TlockBundle;
  return bundle;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The drand chain info the reference verifier reads the public key and scheme from. The
 * verifier supports quicknet only, whose scheme is BLS on G1 with the RFC 9380 DST. */
function chainInfo(chain: SealedChain): Record<string, unknown> {
  return {
    public_key: chain.publicKey,
    period: chain.periodSeconds,
    genesis_time: chain.genesisTime,
    hash: chain.chainHash,
    groupHash: "",
    schemeID: "bls-unchained-g1-rfc9380",
    metadata: { beaconID: "quicknet" },
  };
}

function isHex(value: string): boolean {
  return /^(?:[0-9a-fA-F]{2})+$/.test(value);
}

/**
 * Verify a round's published signature against the chain's public key, exactly as the engine
 * does before it decrypts anything (`round_1000s_signature_verifies`,
 * `a_signature_that_does_not_verify_is_refused`). A malformed signature is simply false.
 */
export async function verifyRoundSignature(
  chain: SealedChain,
  round: number,
  signatureHex: string,
): Promise<boolean> {
  if (!Number.isSafeInteger(round) || round < 1) return false;
  if (!isHex(signatureHex)) return false;
  const signature = Buffer.from(signatureHex, "hex");
  // drand's `randomness` is sha256 of the signature; supplying it keeps the check about the
  // SIGNATURE, which is the thing the document publishes, rather than about a value it cannot.
  const beacon = {
    round,
    signature: signatureHex.toLowerCase(),
    randomness: sha256Hex(signature),
  };
  try {
    return await tlock().verifyBeacon(chainInfo(chain), beacon, round);
  } catch {
    return false;
  }
}

export type OpenBallotResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: "undecryptable" | "wrong_round" | "malformed" };

/**
 * Open one armored age ciphertext with the round's signature, mirroring `open_ballot` in
 * `sealed.rs`:
 *
 *   1. the armor and the age header are read first, so a header that does not parse or a tlock
 *      stanza for another chain hash is `undecryptable`, BEFORE any cryptography;
 *   2. a stanza that names another round is `wrong_round` (decrypting first would make that
 *      reason unreachable, which is why the spec pins the order);
 *   3. the file key is derived from the signature and the age file opened; any failure —
 *      including the header MAC or the file-key hash tlock-js records in the stanza — is
 *      `undecryptable`;
 *   4. a file that opens to bytes that are not UTF-8 is `malformed`, with no plaintext: the
 *      engine's `String::from_utf8` refusal, and the reason it caches for that ballot.
 */
export async function openBallot(
  ciphertext: string,
  chain: SealedChain,
  round: number,
  signatureHex: string,
): Promise<OpenBallotResult> {
  const t = tlock();
  let decoded: string;
  try {
    decoded = t.isProbablyArmored(ciphertext) ? t.decodeArmor(ciphertext) : ciphertext;
  } catch {
    return { ok: false, reason: "undecryptable" };
  }

  let age: DecodedAge;
  try {
    age = t.readAge(decoded);
  } catch {
    return { ok: false, reason: "undecryptable" };
  }

  const stanza = age.header.recipients.find((it) => it.type === "tlock");
  if (stanza === undefined || (stanza.args.length !== 2 && stanza.args.length !== 3)) {
    return { ok: false, reason: "undecryptable" };
  }
  const [roundArg, chainArg, fileKeyHash] = stanza.args as [string, string, string | undefined];
  if (chainArg.toLowerCase() !== chain.chainHash.toLowerCase()) {
    return { ok: false, reason: "undecryptable" };
  }
  if (!/^[0-9]+$/.test(roundArg) || Number(roundArg) !== round) {
    return { ok: false, reason: "wrong_round" };
  }

  if (!isHex(signatureHex)) return { ok: false, reason: "undecryptable" };
  const signature = Buffer.from(signatureHex, "hex");
  const pointLength = t.bls12_381.G2.ProjectivePoint.BASE.toRawBytes(true).byteLength;
  const body = stanza.body;
  const remainder = body.length - pointLength;
  if (remainder <= 0 || remainder % 2 !== 0) return { ok: false, reason: "undecryptable" };
  const half = remainder / 2;

  let fileKey: Uint8Array;
  try {
    fileKey = await t.ibe.decryptOnG2(signature, {
      U: body.subarray(0, pointLength),
      V: body.subarray(pointLength, pointLength + half),
      W: body.subarray(pointLength + half),
    });
  } catch {
    return { ok: false, reason: "undecryptable" };
  }
  // The stanza names the sha256 of the file key; tlock-js checks it too. A signature that is
  // wrong for this ciphertext usually fails the pairing or the header MAC, but a hash check
  // makes the refusal explicit rather than incidental.
  if (fileKeyHash !== undefined && sha256Hex(fileKey) !== fileKeyHash.toLowerCase()) {
    return { ok: false, reason: "undecryptable" };
  }

  let plaintext: Uint8Array;
  try {
    plaintext = await t.decryptAge(decoded, async () => fileKey);
  } catch {
    return { ok: false, reason: "undecryptable" };
  }
  try {
    // `ignoreBOM`: a leading U+FEFF is a character of the plaintext, as it is to Rust's
    // `String::from_utf8`, not a marker to strip (it then fails the tag as `malformed`).
    return {
      ok: true,
      plaintext: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext),
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/**
 * How `cast_vote` decides a selection is castable (contract `consultation_registry.rs`, the
 * abstention, cap, range and ordering asserts). `maxSelections` is the creator's approval cap;
 * under Majority Judgment `candidateCount` replaces it (spec §6.3). `optionCount` is the INDEX
 * SPACE, as the engine's `SelectionRules` and the document's `sealed.option_count` carry it: the
 * option count, the candidate count for an election, the candidate count times the five grades
 * under Majority Judgment.
 */
export interface SelectionRules {
  abstainAllowed: boolean;
  maxSelections: number;
  candidateCount: number;
  majorityJudgment: boolean;
  optionCount: number;
}

export type ValidatePlaintextResult =
  | { ok: true; selection: number[] }
  | { ok: false; reason: "malformed" | "wrong_vote" | "invalid_selection" };

const I64_MAX = 9223372036854775807n;

/**
 * Validate a decrypted plaintext, mirroring `validate_plaintext` in `sealed.rs`. The format is
 * four lines joined by `\n` with no trailing newline: the tag, the consultation id, the account,
 * and the selection — decimal indices without a leading zero, comma-separated, empty for an
 * abstention. A `\r`, a trailing newline, a fifth line, or a malformed index is `malformed`.
 * The binding is checked next (`wrong_vote`), then the rules `cast_vote` enforces
 * (`invalid_selection`).
 */
export function validatePlaintext(
  plaintext: string,
  consultationId: string,
  account: string,
  rules: SelectionRules,
): ValidatePlaintextResult {
  if (plaintext.includes("\r")) return { ok: false, reason: "malformed" };
  const lines = plaintext.split("\n");
  if (lines.length !== 4) return { ok: false, reason: "malformed" };
  const [tag, id, voter, selectionText] = lines as [string, string, string, string];
  if (tag !== SEALED_PLAINTEXT_TAG) return { ok: false, reason: "malformed" };

  const selection: number[] = [];
  if (selectionText !== "") {
    for (const part of selectionText.split(",")) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(part)) return { ok: false, reason: "malformed" };
      const index = BigInt(part);
      // An index beyond i64 cannot have been produced by any vote, and the engine refuses it as
      // malformed at parse time rather than as out of range.
      if (index > I64_MAX) return { ok: false, reason: "malformed" };
      selection.push(Number(index));
    }
  }

  if (id !== consultationId || voter !== account) return { ok: false, reason: "wrong_vote" };

  if (selection.length === 0 && !rules.abstainAllowed) {
    return { ok: false, reason: "invalid_selection" };
  }
  const cap = rules.majorityJudgment ? rules.candidateCount : rules.maxSelections;
  if (selection.length > cap) return { ok: false, reason: "invalid_selection" };

  let previous: number | null = null;
  for (const index of selection) {
    if (index >= rules.optionCount) return { ok: false, reason: "invalid_selection" };
    if (previous !== null && index <= previous) return { ok: false, reason: "invalid_selection" };
    previous = index;
  }
  return { ok: true, selection };
}
