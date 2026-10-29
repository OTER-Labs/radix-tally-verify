#!/usr/bin/env node
/**
 * CLI: verify one tally document against Gateway state and the hash committed on-ledger.
 *
 *   radix-tally-verify <tally.json | -> [--gateway URL] [--tally-hash HEX] [--xrd-resource ADDR]
 *                      [--weight-set FILE] [--excluded-set FILE] [--hash-only]
 *                      [--reread-ballots]
 *
 * `--weight-set` supplies the weight-source set `weight_set_version` names, as
 * `{"network", "weight_set_version", "weight_sources"}`, and `--excluded-set` supplies the barred
 * register `excluded_set_version` names, as
 * `{"excluded_set_version", "excluded_accounts"}`. With them, both versions and both embedded
 * lists are checked against the registry sets they claim; without them they are carried and
 * hashed but not checked.
 *
 * `--reread-ballots` re-reads the sealed ballot box's `SealedBallotCastEvent` stream for a v23
 * sealed vote and compares it with the document's `votes` and `late_ballots` — the one check on a
 * sealed tally that reads the ledger's own record of the ballots.
 *
 * `--hash-only` parses the document and prints its canonical bytes and tally hash without any
 * Gateway read — the offline encoding check, and how the golden vectors are verified.
 *
 * Exit codes are the contract — a keeper or a cron job reads them, not the prose:
 *   0  MATCH        figures recompute exactly and (when a hash was supplied) the hash agrees
 *   1  FIGURES      a published figure is not what the recomputation produces — the real signal
 *   2  SERIALIZATION  figures agree, hash does not — a spec departure, not a lie
 *   3  UNKNOWN      the gateway was unreachable or the pinned state version is pruned
 *   4  MALFORMED    the input is not a readable tally document
 */

import { readFileSync } from "node:fs";

import { canonicalize, tallyHash } from "./canonical.ts";
import type { Json } from "./canonical.ts";
import {
  DocumentError,
  parsePinnedExcludedSet,
  parsePinnedWeightSet,
  parseTallyDocument,
} from "./document.ts";
import type { PinnedExcludedSet, PinnedWeightSet, TallyDocument } from "./document.ts";
import { compareSealedBallotEvents, streamSealedBallotEvents } from "./events.ts";
import { GatewayError, RadixGateway } from "./gateway.ts";
import { verifyTallyDocument } from "./verify.ts";

const MAINNET_XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
const STOKENET_XRD = "resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc";
const DEFAULT_GATEWAY = "https://mainnet.radixdlt.com";

interface Args {
  file: string;
  gateway: string;
  tallyHash: string | null;
  xrdResource: string | null;
  weightSet: string | null;
  excludedSet: string | null;
  hashOnly: boolean;
  rereadBallots: boolean;
}

function usage(): never {
  process.stderr.write(
    "usage: radix-tally-verify <tally.json | -> [--gateway URL] [--tally-hash HEX] [--xrd-resource ADDR] [--weight-set FILE] [--excluded-set FILE] [--hash-only] [--reread-ballots]\n",
  );
  process.exit(4);
}

function parseArgs(argv: string[]): Args {
  let file: string | null = null;
  let gateway = DEFAULT_GATEWAY;
  let tallyHash: string | null = null;
  let xrdResource: string | null = null;
  let weightSet: string | null = null;
  let excludedSet: string | null = null;
  let hashOnly = false;
  let rereadBallots = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (
      a === "--gateway" ||
      a === "--tally-hash" ||
      a === "--xrd-resource" ||
      a === "--weight-set" ||
      a === "--excluded-set"
    ) {
      const v = argv[++i];
      if (v === undefined) usage();
      if (a === "--gateway") gateway = v;
      else if (a === "--tally-hash") tallyHash = v;
      else if (a === "--weight-set") weightSet = v;
      else if (a === "--excluded-set") excludedSet = v;
      else xrdResource = v;
    } else if (a === "--hash-only") {
      hashOnly = true;
    } else if (a === "--reread-ballots") {
      rereadBallots = true;
    } else if (a.startsWith("--")) {
      usage();
    } else if (file === null) {
      file = a;
    } else {
      usage();
    }
  }
  if (file === null) usage();
  return { file, gateway, tallyHash, xrdResource, weightSet, excludedSet, hashOnly, rereadBallots };
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

  // Offline encoding check: print the canonical bytes and their hash. This is deliberately not a
  // shape check — an encoding vector need not be a whole tally document — and it is how a golden
  // vector is checked anywhere, with no Gateway read. An API envelope is unwrapped first, since
  // its `document_hash_blake2b` is the hash of the inner document.
  if (args.hashOnly) {
    const maybeEnvelope =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null;
    const raw = (maybeEnvelope !== null && maybeEnvelope["document"] !== undefined
      ? maybeEnvelope["document"]
      : input) as Json;
    let canonical: string;
    let hash: string;
    try {
      canonical = canonicalize(raw);
      hash = tallyHash(raw);
    } catch (e) {
      process.stderr.write(
        `SERIALIZATION DISAGREEMENT: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exit(2);
    }
    process.stdout.write(`canonical=${canonical}\nhash=${hash}\n`);
    if (args.tallyHash !== null && args.tallyHash !== hash) {
      process.stdout.write(`expected=${args.tallyHash}\n`);
      process.exit(2);
    }
    process.exit(0);
  }

  let weightSet: PinnedWeightSet | undefined;
  if (args.weightSet !== null) {
    try {
      weightSet = parsePinnedWeightSet(JSON.parse(readFileSync(args.weightSet, "utf8")));
    } catch (e) {
      process.stderr.write(`MALFORMED: --weight-set ${args.weightSet}: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(4);
    }
  }

  let excludedSet: PinnedExcludedSet | undefined;
  if (args.excludedSet !== null) {
    try {
      excludedSet = parsePinnedExcludedSet(JSON.parse(readFileSync(args.excludedSet, "utf8")));
    } catch (e) {
      process.stderr.write(`MALFORMED: --excluded-set ${args.excludedSet}: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(4);
    }
  }

  const xrdResource = args.xrdResource ?? defaultXrdResource(args.gateway);
  if (xrdResource === null) {
    process.stderr.write(
      `cannot tell which network ${args.gateway} serves — pass --xrd-resource explicitly\n`,
    );
    process.exit(4);
  }

  // v22: echo which space/term this document claims, ahead of the verdict — a no-op on any
  // document that verifies wrong, and on any document this parse itself refuses (verifyTallyDocument
  // reports that below as MALFORMED; there is nothing to echo yet).
  let parsedDoc: TallyDocument | null = null;
  try {
    const { doc } = parseTallyDocument(input);
    parsedDoc = doc;
    const config =
      doc.weightConfig.kind === "Xrd" ? "Xrd" : `${doc.weightConfig.kind}:${doc.weightConfig.resource}`;
    process.stdout.write(
      `space_id=${doc.spaceId} weight_config=${config} term_seconds=${doc.termSeconds} asset_symbol=${doc.assetSymbol}\n`,
    );
  } catch (e) {
    if (!(e instanceof DocumentError)) throw e;
  }

  // v23: re-read the box's own ballot events and compare them with the document's ballot list.
  // Runs before the tally verification: it needs no weight read, and a ledger disagreement it
  // finds is a definite finding whatever the Gateway would say about weights.
  if (args.rereadBallots && parsedDoc !== null) {
    const sealedDoc = parsedDoc;
    if (sealedDoc.sealed === null) {
      process.stderr.write("MALFORMED: --reread-ballots needs a v23 sealed tally document\n");
      process.exit(4);
    }
    let events;
    try {
      // The snapshot is at or before vote_start and the box exists before the consultation, so
      // no ballot can be older than it.
      events = await streamSealedBallotEvents(
        args.gateway,
        sealedDoc.sealed.box,
        sealedDoc.snapshotStateVersion,
      );
    } catch (e) {
      if (e instanceof GatewayError) {
        process.stdout.write(
          "UNKNOWN — the box's ballot stream could not be read. This says nothing about the tally.\n" +
            `  ${e.message}\n`,
        );
        process.exit(3);
      }
      throw e;
    }
    const differences = compareSealedBallotEvents(events, sealedDoc);
    if (differences.length > 0) {
      process.stdout.write(
        `FIGURES DISAGREE — the ballot list differs from the box's events: ${differences.length} difference(s).\n`,
      );
      for (const d of differences) {
        process.stdout.write(`  ${d.field}: document ${d.document} != ledger ${d.recomputed}\n`);
      }
      process.exit(1);
    }
    const forVote = events.filter((e) => e.consultationId === sealedDoc.consultationId).length;
    process.stdout.write(
      `reread: ${forVote} sealed ballot event(s) match votes and late_ballots.\n`,
    );
  }

  const outcome = await verifyTallyDocument(
    input,
    args.tallyHash,
    new RadixGateway(args.gateway),
    xrdResource,
    {
      ...(weightSet === undefined ? {} : { weightSet }),
      ...(excludedSet === undefined ? {} : { excludedSet }),
    },
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
