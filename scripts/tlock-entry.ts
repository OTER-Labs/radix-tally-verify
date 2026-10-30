/**
 * esbuild entry for the tlock-js bundle (`scripts/build-tlock.mjs` → `vendor/tlock-js.cjs`).
 *
 * tlock-js (the fork every OTER layer pins, `github:a137x/tlock-js`) ships TypeScript source
 * only, and node's `--experimental-strip-types` refuses files under `node_modules`. This entry
 * re-exports exactly the pieces `src/sealed.ts` needs, plus the low-level age/IBE helpers, so
 * one small CommonJS bundle can be required through the package's `#tlock` subpath import.
 *
 * The high-level `timelockDecrypt` is deliberately not what the verifier calls: it fetches the
 * beacon from drand and logs it. The verifier verifies the PUBLISHED signature itself and feeds
 * the resulting file key to `decryptAge`.
 */

export {
  decodeArmor,
  encodeArmor,
  isProbablyArmored,
} from "tlock-js/src/age/armor.ts";
export { readAge } from "tlock-js/src/age/age-reader-writer.ts";
export { decryptAge } from "tlock-js/src/age/age-encrypt-decrypt.ts";
export * as ibe from "tlock-js/src/crypto/ibe.ts";
export { bls12_381 } from "@noble/curves/bls12-381";
export { verifyBeacon } from "drand-client/beacon-verification.js";
export { timelockEncrypt, timelockDecrypt } from "tlock-js/src/index.ts";
