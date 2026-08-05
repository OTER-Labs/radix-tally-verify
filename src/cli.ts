#!/usr/bin/env node
/**
 * CLI: verify one tally document against Gateway state and the hash committed on-ledger.
 *
 *   radix-tally-verify <tally.json | -> [--gateway URL] [--tally-hash HEX] [--xrd-resource ADDR]
 *
 * Exit codes are the contract — a keeper or a cron job reads them, not the prose:
 *   0  MATCH        figures recompute exactly and (when a hash was supplied) the hash agrees
 *   1  FIGURES      a published figure is not what the recomputation produces — the real signal
 *   2  SERIALIZATION  figures agree, hash does not — a spec departure, not a lie
 *   3  UNKNOWN      the gateway was unreachable or the pinned state version is pruned
 *   4  MALFORMED    the input is not a readable tally document
 */

import { readFileSync } from "node:fs";

import { RadixGateway } from "./gateway.ts";
import { verifyTallyDocument } from "./verify.ts";

const MAINNET_XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
const STOKENET_XRD = "resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc";
const DEFAULT_GATEWAY = "https://mainnet.radixdlt.com";

interface Args {
  file: string;
  gateway: string;
  tallyHash: string | null;
  xrdResource: string | null;
}

function usage(): never {
  process.stderr.write(
    "usage: radix-tally-verify <tally.json | -> [--gateway URL] [--tally-hash HEX] [--xrd-resource ADDR]\n",
  );
  process.exit(4);
}

function parseArgs(argv: string[]): Args {
  let file: string | null = null;
  let gateway = DEFAULT_GATEWAY;
  let tallyHash: string | null = null;
  let xrdResource: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--gateway" || a === "--tally-hash" || a === "--xrd-resource") {
      const v = argv[++i];
      if (v === undefined) usage();
      if (a === "--gateway") gateway = v;
      else if (a === "--tally-hash") tallyHash = v;
      else xrdResource = v;
    } else if (a.startsWith("--")) {
      usage();
    } else if (file === null) {
      file = a;
    } else {
      usage();
    }
  }
  if (file === null) usage();
  return { file, gateway, tallyHash, xrdResource };
}

/** The XRD resource address follows the network, which the gateway URL names. An unknown
 * gateway must say which XRD it means rather than have one guessed for it. */
function defaultXrdResource(gateway: string): string | null {
  if (gateway.includes("stokenet")) return STOKENET_XRD;
  if (gateway.includes("mainnet")) return MAINNET_XRD;
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let text: string;
  try {
    text = args.file === "-" ? readFileSync(0, "utf8") : readFileSync(args.file, "utf8");
  } catch (e) {
    process.stderr.write(`cannot read ${args.file}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(4);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (e) {
    process.stderr.write(`MALFORMED: not JSON: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(4);
  }

  const xrdResource = args.xrdResource ?? defaultXrdResource(args.gateway);
  if (xrdResource === null) {
    process.stderr.write(
      `cannot tell which network ${args.gateway} serves — pass --xrd-resource explicitly\n`,
    );
    process.exit(4);
  }

  const outcome = await verifyTallyDocument(
    input,
    args.tallyHash,
    new RadixGateway(args.gateway),
    xrdResource,
  );

  switch (outcome.kind) {
    case "match":
      process.stdout.write(
        outcome.hashChecked
          ? "MATCH: every figure recomputes exactly, and the tally_hash agrees.\n"
          : "MATCH (figures only): every figure recomputes exactly; no tally_hash was supplied to check.\n",
      );
      process.exit(0);
      break;
    case "figures":
      process.stdout.write(
        `FIGURES DISAGREE — the real signal: ${outcome.differences.length} figure(s) differ.\n`,
      );
      for (const d of outcome.differences) {
        process.stdout.write(`  ${d.field}: document ${d.document} != recomputed ${d.recomputed}\n`);
      }
      process.exit(1);
      break;
    case "serialization":
      process.stdout.write(
        "SERIALIZATION DISAGREEMENT — figures match, hash differs. One implementation departed " +
          "from the canonical spec; this is not evidence of a lie.\n" +
          `  ${outcome.detail}\n`,
      );
      process.exit(2);
      break;
    case "unknown":
      process.stdout.write(
        "UNKNOWN — the recomputation could not be completed. This says nothing about the tally.\n" +
          `  ${outcome.reason}\n`,
      );
      process.exit(3);
      break;
    case "malformed":
      process.stderr.write(`MALFORMED: ${outcome.reason}\n`);
      process.exit(4);
      break;
  }
}

main().catch((e) => {
  process.stderr.write(`unexpected failure: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(3);
});
