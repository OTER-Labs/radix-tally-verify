# radix-tally-verify

Independently recompute a Radix governance consultation's tally from Gateway state, and check it
against the hash committed on-ledger.

**Status: working.** The full pipeline exists: weight recomputation from Gateway historical
state, verdict re-derivation, canonical re-serialization, and the hash check, behind a CLI
whose exit codes distinguish the three outcomes above.

---

## Why this exists

A governance result you cannot recompute is a result you have to trust someone about.

The Radix DAO's own framework says so. Its Result Determination Procedure requires publishing *"raw
results, quorum calculation, threshold applied, and winner determination"* for every vote, and it
chose its Majority Judgment tie-break specifically because the rule *"is computed in a single pass
over the recorded tallies, alters no vote data, and can be verified by any member from the published
result. Given the same votes and voting powers it must produce the same outcome."*

That is a reproducibility requirement, written by the people it binds. This tool is the other half
of it: the part that lets someone who was not involved check the answer.

It is deliberately **not** written by the same code, in the same language, as the system it checks.
A verifier that shares an implementation with the thing it verifies agrees with it by construction,
including where both are wrong.

## What it checks

A tally document states everything its verdict depends on — the weight rule, the source register,
the snapshot state version, the quorum and threshold that were applied, and the ballots. Given one,
this tool:

1. **Recomputes each voter's weight** from Radix Gateway historical state at the snapshot the
   document pins — XRD plus validator stake units at their redemption rate, plus whatever the
   document's own source register says counts.
2. **Re-derives the verdict** by applying the document's stated rules to those weights — including
   the DAO-controlled-funds bar, which strikes ballots cast from accounts the document's
   `excluded_accounts` register names.
3. **Re-serializes and re-hashes** the result, and compares against the `tally_hash` committed
   on-ledger.

Step 3 is the cheap one. Steps 1 and 2 are the point.

## What a mismatch means

Not all disagreements are equal, and reporting them as though they were is how a verifier becomes
noise:

| What differs | What it means |
|---|---|
| Figures match, hash differs | A **serialization** disagreement, not a lie. One implementation departed from the spec — most often by parsing a `Decimal` string as a float, or by preserving insertion order instead of sorting keys. |
| Figures differ | The real signal. Someone's arithmetic, weights, or ballot set is not what they published. |
| Gateway unreachable, or the snapshot state version pruned | **Unknown**, not "failed". A verifier that reports infrastructure trouble as a discrepancy trains people to ignore it. |

## What works today

- **`src/decimal.ts`** — scrypto `Decimal` arithmetic: signed 192-bit fixed point, 18 decimal
  places, truncating division. No floats anywhere, and none may be introduced: an IEEE-754 double
  carries ~15–16 significant decimal digits and these values carry 18 after the point alone.
- **`src/canonical.ts`** — the canonical JSON encoding and the blake2b-256 tally hash.
- **`src/gateway.ts`** — a minimal Gateway client pinned to an explicit `state_version`, covering
  only the three endpoints the weight rule reads.
- **`src/weights.ts`** — the weight rule itself: XRD plus validator stake units at their
  redemption rate plus round-trip-verified native pool units, under the register the document
  carries. Pool units held *by* a pool are not followed (one level), and non-fungible liquidity
  positions are not counted — both deliberate, both inherited from the reference rule.
- **`src/verdict.ts`** — quorum (both legs), the Binding gates (strict decisive ratio, MAS
  floor), the DAO-controlled-funds bar, and the three seat rules (Plurality, SPAV, Majority
  Judgment) applied from the document's own stated parameters.
- **`src/verify.ts` / `src/cli.ts`** — orchestration and the command line.
- **`test/`** — cross-implementation agreement, plus weight and verdict logic against fixture
  Gateway responses. No test touches the network.

What is deliberately not recomputed: the ballot set itself, the withdrawn-candidate set and the
`excluded_accounts` register are indexer/ledger facts the Gateway historical endpoints used here do
not serve; they are inputs, covered by the hash like everything else. `eligible_voting_power` is a
creation-time figure and is likewise carried, not re-derived.

## The DAO-controlled-funds bar

The framework's charter §5 says *"Funds under the DAO's control may not be used for governance
participation. No balance in an account the DAO controls may be voted, delegated, or used to file
or support any governance action"* — and, in the same breath, that *"this determines who may vote;
it does not change how quorum is measured."*

Document version **15** carries two things for it:

- **`excluded_accounts`** — the barred accounts, ascending by UTF-8 bytes, `[]` when nothing is
  barred. It sits beside `weight_sources` and inside the hash for the same reason that one does: a
  challenger who applied a different list would recompute a different tally and blame the
  arithmetic.
- **`"excluded": true`** on the ballots it strikes. The barred ballot **stays in `votes`**. It has
  to: a verifier that never saw the ballot could not confirm the exclusion was applied, only that
  something is missing.

A barred ballot is **not a vote**. It reaches no option total, no `total_weight`, no
`abstain_weight` (a barred empty selection abstains from nothing), no `voter_count`, no Majority
Judgment grade weight and no candidate's `cast`. It is the account that did not vote.

Quorum keeps its exact form — `total_weight >= quorum AND voter_count >= min_unique_voters` —
measured over what is left. No threshold is rescaled to compensate: the barred account never had a
vote to withdraw. Striking a large enough holder can therefore *lose* a consultation its quorum,
and that is the correct answer, not a rounding problem to be smoothed away.

Both the register and the flags are checked, not believed. The register decides; each ballot's
`excluded` flag is a published claim compared against it, and the barred account's published
`weight` is still recomputed from Gateway state — otherwise `excluded` would be a place to hide a
wrong figure.

**Version 14 documents keep verifying.** An absent register is `[]` and an absent flag is `false`,
so a document written before the bar existed takes the same path it always did and hashes to the
same bytes.

## Running it

```
npm install && npm run build
radix-tally-verify <tally.json | -> [--gateway URL] [--tally-hash HEX] [--xrd-resource ADDR]
```

The input may be the bare document or the API envelope (`{"document": …, "document_hash_blake2b":
…}`). The gateway defaults to mainnet; the XRD resource address follows from the gateway URL
(`mainnet` / `stokenet`), or pass `--xrd-resource` for anything else.

Exit codes are the contract:

| Code | Outcome |
|---|---|
| 0 | **Match** — every figure recomputes exactly, and the hash agrees when one was supplied |
| 1 | **Figures disagree** — the real signal |
| 2 | **Serialization disagreement** — figures match, hash differs; a spec departure, not a lie |
| 3 | **Unknown** — gateway unreachable or the pinned state version pruned |
| 4 | **Malformed** — the input is not a readable tally document |

## Running the tests

```
npm install
npm test
```

## The specification

The canonical encoding is specified in `docs/canonical-tally-serialization.md`, alongside the
reference implementation. Four rules make the encoding a function of the content: no insignificant
whitespace; object keys ascending by UTF-8 byte sequence at every level; every quantity that is not
a small integer is a JSON **string**; arrays keep their order.

## Scope

This verifies **consultation tally documents** — ballots, weights, gates, verdict. It does not
verify oracle requests, bonds, or dispute settlement, which are a different object with different
inputs.

## License

Apache-2.0.
