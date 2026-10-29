#!/usr/bin/env node
/**
 * Bundle tlock-js into `vendor/tlock-js.cjs`.
 *
 * The fork ships TypeScript source only (`main` names a file its own build never emits), and
 * node's type-stripping refuses `node_modules`, so the verifier compiles the same source the
 * frontend runs into one CommonJS file — the pattern `backend/tools/tlock-encrypt` uses, which
 * is where the pinned git ref comes from. `src/sealed.ts` requires it through `#tlock`.
 *
 * Run by `prepare` (an install), `pretest` and `build`; the output is gitignored.
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(ROOT, "scripts", "tlock-entry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(ROOT, "vendor", "tlock-js.cjs"),
  logLevel: "warning",
});
