/**
 * The official Radix DAO Consultation App's own eligibility list, as shipped data.
 *
 * A mirror tally publishes two readings of the same official ballots. One of them is meant to
 * reproduce the OFFICIAL number, so it has to apply the official rule — and that rule is not
 * "liquid XRD". The app (`vote.radixdao.org/about/voting-power`) states it as: direct XRD; the
 * stake units of every active validator at their underlying XRD; LSULP at its underlying
 * liquid-staked XRD; and the XRD/LSU/LSULP side of a **static allowlist of DEX liquidity
 * positions** — "This is the current static allowlist used when a vote is snapshotted." The
 * first two are constitutional (the governance framework's Tier 1) and are counted
 * unconditionally by {@link computeAccountWeightBreakdown}; the last two are the list this
 * module carries.
 *
 * **Why a file this package ships, rather than a number it trusts from the document.** The
 * document says which list it was weighed under (`official_rule.allowlist_version` and a
 * blake2b-256 `allowlist_hash` over the list's canonical entries). If this verifier took the
 * list itself from the document, that field would be unfalsifiable — a document could name any
 * positions it liked and be "verified" against its own claim. So the list travels with the
 * verifier, the hash is recomputed here, and a document weighed under a different list is a
 * DIFFERENCE rather than a silent pass. When the app changes its allowlist, this package ships
 * a new version of the file and an old document stops verifying against it — which is the
 * correct outcome and the reason the version is published at all.
 *
 * The two files under `data/` are transcriptions, not the app's own artifacts: the app hard-codes
 * its positions inside a JavaScript bundle. `data/official-allowlist.mainnet.json` records that
 * bundle's list; `data/official-allowlist.stokenet.json` states the same policy for a test
 * network none of those DEXes deploy to, which is why its list is empty.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { tallyHash } from "./canonical.ts";
import type { Json } from "./canonical.ts";
import { DocumentError } from "./document.ts";
import type { WeightSources } from "./weights.ts";

/** The networks a list is shipped for. */
export type AllowlistNetwork = "mainnet" | "stokenet";

/**
 * The four entry kinds, spelled exactly as the on-ledger weight-source register spells them, so
 * that comparing the app's list with the DAO's register is comparing like with like.
 */
const KNOWN_KINDS = ["Lsulp", "NativePool", "PrecisionPool", "ShapePool"] as const;
type AllowlistKind = (typeof KNOWN_KINDS)[number];

/**
 * One allowlisted position: what the app calls it (`dex` / `pair`), the pool it lives in, and the
 * resource an account actually holds — a pool unit, a liquidity receipt, or the LSULP fungible.
 *
 * All five fields are inside the hash. The labels are hashed too, deliberately: a list whose
 * names could change without changing its hash would let two different-looking transcriptions
 * claim the same provenance.
 */
export interface OfficialAllowlistEntry {
  kind: AllowlistKind;
  dex: string;
  pair: string;
  component: string;
  resource: string;
}

export interface OfficialAllowlist {
  network: AllowlistNetwork;
  /** The list's own version string — what `official_rule.allowlist_version` must equal. */
  version: string;
  sourceUrl: string;
  entries: OfficialAllowlistEntry[];
  /** blake2b-256, lowercase hex, of the canonical JSON of `entries` alone. */
  hash: string;
  /** The list expressed as a weight-source register, ready for `computeAccountWeightBreakdown`. */
  sources: WeightSources;
}

/**
 * The canonical bytes the hash is taken over: `entries` alone, canonicalized by this package's
 * own {@link tallyHash} — no insignificant whitespace, keys ascending, array order preserved.
 *
 * Only `entries` is hashed. The provenance fields say where the list came from, and re-fetching
 * the same list from a new URL on a new date must not change the identity of the RULE: two
 * implementations that apply the same positions have to agree, or the hash stops answering the
 * question it exists for.
 */
export function allowlistHash(entries: OfficialAllowlistEntry[]): string {
  return tallyHash(entries as unknown as Json);
}

/**
 * `entries` -> the register shape the weight engine takes.
 *
 * `native_pools` is a NAMED allowlist and never `all`: the official rule counts the pools it
 * names and no others, which is the whole meaning of "static allowlist" — a network with no
 * named pool counts no pool unit rather than counting every one it can discover. The delegation
 * leg is absent (= off) because the official rule has none, and neither space leg can appear:
 * a mirror is always the Radix electorate.
 */
export function allowlistWeightSources(entries: OfficialAllowlistEntry[]): WeightSources {
  const named = (kind: AllowlistKind): string[] =>
    entries.filter((e) => e.kind === kind).map((e) => e.component);
  const nativePools = named("NativePool");
  const precision = named("PrecisionPool");
  const shape = named("ShapePool");
  const lsulp = entries.find((e) => e.kind === "Lsulp");
  const sources: WeightSources = {
    native_pools: nativePools.length === 0 ? { mode: "off" } : { mode: "allowlist", pools: nativePools },
  };
  if (lsulp !== undefined) {
    sources.lsulp = { mode: "component", component: lsulp.component, resource: lsulp.resource };
  }
  if (precision.length > 0) sources.precision_pools = { mode: "allowlist", pools: precision };
  if (shape.length > 0) sources.shape_pools = { mode: "allowlist", pools: shape };
  return sources;
}

function parseEntries(raw: unknown, network: AllowlistNetwork): OfficialAllowlistEntry[] {
  if (!Array.isArray(raw)) {
    throw new DocumentError(`official allowlist for ${network}: "entries" is not an array`);
  }
  return raw.map((item, i) => {
    const o = item as Record<string, unknown>;
    const field = (name: string): string => {
      const v = o[name];
      if (typeof v !== "string" || v.length === 0) {
        throw new DocumentError(`official allowlist for ${network}: entries[${i}].${name} is missing`);
      }
      return v;
    };
    const kind = field("kind");
    if (!(KNOWN_KINDS as readonly string[]).includes(kind)) {
      // An unknown kind would be silently dropped by the register mapping above, which for this
      // file would mean quietly under-counting the official rule while still reporting a hash
      // over a list the verifier did not apply.
      throw new DocumentError(
        `official allowlist for ${network}: entries[${i}].kind is ${JSON.stringify(kind)}, ` +
          `which this verifier cannot weigh — known kinds are ${JSON.stringify(KNOWN_KINDS)}`,
      );
    }
    return {
      kind: kind as AllowlistKind,
      dex: field("dex"),
      pair: field("pair"),
      component: field("component"),
      resource: field("resource"),
    };
  });
}

/**
 * Find `data/` whichever depth this module was loaded from: `src/allowlist.ts` when the package
 * is run from source (the tests, and `node --experimental-strip-types`), `dist/src/allowlist.js`
 * once compiled. Walking up beats hard-coding either depth, which is a bug that only shows up in
 * whichever of the two nobody ran before publishing.
 */
function dataDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 5; up++) {
    const candidate = join(dir, "data");
    try {
      readFileSync(join(candidate, "official-allowlist.mainnet.json"));
      return candidate;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new DocumentError(
    "this package's data/official-allowlist.*.json files could not be found next to the module " +
      "that loads them — the official rule cannot be recomputed without the list it applies",
  );
}

const CACHE = new Map<AllowlistNetwork, OfficialAllowlist>();

/** The shipped list for one network, parsed, hashed and mapped to a register once. */
export function loadOfficialAllowlist(network: AllowlistNetwork): OfficialAllowlist {
  const cached = CACHE.get(network);
  if (cached !== undefined) return cached;
  const path = join(dataDir(), `official-allowlist.${network}.json`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new DocumentError(
      `official allowlist for ${network} could not be read from ${path}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (raw["schema"] !== "oter-official-allowlist/1") {
    throw new DocumentError(
      `official allowlist for ${network} declares schema ${JSON.stringify(raw["schema"])}, ` +
        `this verifier implements "oter-official-allowlist/1"`,
    );
  }
  if (raw["network"] !== network) {
    throw new DocumentError(
      `${path} declares network ${JSON.stringify(raw["network"])} — a list for the wrong network ` +
        `would weigh the official leg against entities that do not exist there`,
    );
  }
  const entries = parseEntries(raw["entries"], network);
  const allowlist: OfficialAllowlist = {
    network,
    version: String(raw["version"] ?? ""),
    sourceUrl: String(raw["source_url"] ?? ""),
    entries,
    hash: allowlistHash(entries),
    sources: allowlistWeightSources(entries),
  };
  CACHE.set(network, allowlist);
  return allowlist;
}

/**
 * Which list applies to an official `Governance` component, from the component address's own
 * bech32 prefix.
 *
 * The same network detection the reference engine uses for its Gateway host, and for the same
 * reason: the balances, the ballots and the allowlist all have to come from one network, and an
 * address says which one it lives on without anybody having to configure it.
 */
export function officialAllowlistFor(component: string): OfficialAllowlist {
  return loadOfficialAllowlist(component.startsWith("component_rdx1") ? "mainnet" : "stokenet");
}
