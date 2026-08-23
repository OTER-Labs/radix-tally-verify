# radix-tally-verify

Independently recompute a Radix governance consultation's tally from Gateway state, and check it
against the hash committed on-ledger.

**Status: working. Supported tally document version: 20.** The full pipeline exists: weight
recomputation from Gateway historical state, verdict re-derivation, canonical re-serialization,
and the hash check, behind a CLI whose exit codes distinguish the three outcomes above.

No document is refused for its version. Verification is driven by field presence, so one written
before any given leg existed takes the absent-means-off path on each field and verifies exactly as
it did before that leg was added. The version number itself is read for one purpose only: the
v19→v20 verdict change is a *comparison* rather than a field, so each document's `approved` is
recomputed under the bar in force when it was settled — see
[the approval bar](#the-approval-bar-is-at-or-above).

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
   `excluded_accounts` register names, and the Grade Quantile the document publishes, which
   decides where a Majority Judgment candidate's grade settles.
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
| The document's own register names a component the ledger says is not that thing | **Malformed**, not a discrepancy. The gateway answered and contradicted the document: its stated weight rule cannot be applied to the ledger it pins, so there is no figure to disagree about. Calling that a discrepancy would accuse a publisher of arithmetic they never got to do. |

## What works today

- **`src/decimal.ts`** — scrypto `Decimal` arithmetic: signed 192-bit fixed point, 18 decimal
  places, truncating division. No floats anywhere, and none may be introduced: an IEEE-754 double
  carries ~15–16 significant decimal digits and these values carry 18 after the point alone.
- **`src/canonical.ts`** — the canonical JSON encoding and the blake2b-256 tally hash.
- **`src/gateway.ts`** — a minimal Gateway client pinned to an explicit `state_version`, covering
  only the three endpoints the weight rule reads.
- **`src/precise.ts`** — scrypto `PreciseDecimal`: the 36-decimal, I256 fixed point the
  concentrated-liquidity legs are evaluated in before being narrowed back to 18. A separate type
  from `Dec` on purpose, because the two scales are not interchangeable in the rule.
- **`src/weights.ts`** — the weight rule itself, under the register the document carries. See the
  coverage table below for which legs are read and how.
- **`src/concentrated.ts`** — the two concentrated-liquidity legs: the tick power, the
  three-branch removable-amount split, the bin-claim resolution, and the non-fungible read path
  they need.
- **`src/delegation.ts`** — the delegation resolution: one hop, direct-ballot revocation, the
  effectiveness conditions, and the bar enforced on the delegation graph.
- **`src/verdict.ts`** — quorum (both legs), the Binding gates (the at-or-above decisive ratio
  with its `decisive > 0` guard, and the MAS floor), the DAO-controlled-funds bar, the
  valid-ballots-only Participation rule, delegated weight riding the ballot it attached to, and
  the three seat rules (Plurality, SPAV, Majority Judgment) applied from the document's own
  stated parameters, down to the Grade Quantile it publishes.
- **`src/verify.ts` / `src/cli.ts`** — orchestration and the command line.
- **`test/`** — cross-implementation agreement, plus weight, concentrated-liquidity, delegation
  and verdict logic against fixture Gateway responses, and each leg driven end to end through the
  whole tool. No test touches the network.

## Coverage, leg by leg

The weight rule is a sum over sources, and the register the document carries decides which of them
are switched on. Every leg below is recomputed from Gateway historical state at the document's own
`snapshot_state_version`:

| Leg | Doc version | What is read | Status |
|---|---|---|---|
| Liquid **XRD** | — | account balances, every page | recomputed |
| **Validator stake units** | — | LSU balance × validator stake ÷ LSU supply | recomputed |
| **Native pool units** | 4 | pro-rata of the pool's XRD backing, admitted only by the two-way `pool` / `pool_unit` metadata round trip into the `pool_` address space | recomputed |
| **LSULP** | 16 | the named component's `dex_valuation_xrd` ÷ the named resource's supply; named-or-off, never discovered | recomputed |
| **Precision pools** (Ociswap `PrecisionPool`, V1 and V2) | 17 | position NFT data and the pool's `price_sqrt`, through the 36-place tick power and the three-branch split; principal only | recomputed |
| **Shape pools** (CaviarNine `QuantaSwap`) | 17 | receipt `liquidity_claims` against `tick_index.current`, the active reserves, and the full `bin_map` key-value store | recomputed |
| **Delegation** | 18 | the resolution, the per-delegate sums, and their effect on every total and on the verdict | recomputed **from a carried input** — see below |

And the verdict, in full: quorum on both legs, the Binding gates, the DAO-controlled-funds bar,
Majority Judgment's qualifying grades and gauges at the document's own quantile, `invalid_ballots`,
the withdrawn-candidate exclusion, and every seat allocation.

## What is not recomputed, and why

A verifier that is vague about which of its inputs it checked is worse than one that checks less.
Four things are **inputs**, carried inside the hashed document rather than derived:

- **The ballot set**, the **withdrawn-candidate set** and the **`excluded_accounts` register** —
  indexer and registry facts the Gateway historical state endpoints do not serve.
- **`eligible_voting_power`**, a creation-time figure.
- **`delegation_input`** — *which* delegations were in force at the snapshot, and which delegates
  had declined. That is a fold over the delegation component's whole write history ordered by
  `(state_version, sequence)`, which reaches the reference engine through an event indexer, not
  through the Gateway. Everything downstream of it is recomputed: the resolution and its published
  refusal reasons, each delegator's weight, the per-delegate sums, `delegated_weight_total`, the
  per-ballot `delegated_weight` / `effective_weight` split, and every total and verdict they feed.
- **`weight_set_version` and `excluded_set_version`** (v19) — carried, hashed, and not checked
  against the registry. Their purpose is to let someone fetch those two on-ledger sets *by version*
  and confirm the lists this document embeds are the ones it claims to be; doing that needs the
  consultation registry, which is a different source from the Gateway state endpoints this tool
  reads. **This is the one gap in the v19 coverage**, and closing it would mean teaching the tool
  to read the registry.

All of them are covered by the hash exactly as everything else is, so a document that altered one
would fail the hash check against what was committed on-ledger.

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

## The approval bar is at-or-above

A Binding consultation passes when

```
quorum_met
  AND (approve + reject) > 0
  AND approve * 100 >= (approve + reject) * approval_threshold_pc
  AND approve >= min_affirmative_support
```

The ratio comparison is **inclusive** — document version 20. Through v19 it was strictly greater,
and that was wrong on the framework's own text: the Parameters Registry writes every bar as
*"≥ 66% / ≥ 60% / ≥ 50% YES"*, and the Proposal & Voting Framework says a proposal passes when it
*meets* the approval threshold. Under the strict comparison an exact tie at a 50 bar failed and a
100 bar was unreachable even by unanimity, which is not what either bar says.

The inclusive test needs a guard the strict one did not. With no decisive vote at all, `0 >= 0` is
true, so without `(approve + reject) > 0` every quorate abstention-only consultation would clear
its ratio and pass on nothing whatsoever. Quorum counts abstaining weight — that is the whole
reason an empty ballot is legal — so this is a reachable state, not a theoretical one.

**Which comparison applies is the document's to say, not this verifier's.** A document publishing
`tally_doc_version` 20 or above is recomputed inclusively; anything below — or a document
publishing no version at all — is recomputed with the strict comparison it was settled under.

That is the [Grade Quantile](#the-grade-quantile-is-the-documents-not-the-verifiers) rule applied
to the other moving bar, for the same reason. A v19 consultation that landed exactly on its bar was
correctly recorded as failing under the rule in force when it was settled, and a verifier that
applied today's comparison to it would report a correct historical tally as a lie. An absent
version pins the recomputation to the older rule: absence is not a licence to have applied an
unannounced newer one.

The two comparisons disagree only about a tally sitting exactly on its bar. Everywhere else they
return the same answer, which is why the change touches so few results.

## The Grade Quantile is the document's, not the verifier's

A Majority Judgment candidate's **qualifying grade** is the highest grade whose at-or-above weight
reaches the *Grade Quantile* of the weight cast for them. That quantile is **three-fifths** today.
It was the median until 2026-08-05.

So a stored result recomputed under today's quantile is not necessarily recomputable at all — it
was settled under a different rule, and a verifier that hardcoded the current one would report
every correct historical election as a lie. The framework's answer (Proposal & Voting Framework
§6.5) is that every result states the fraction it was settled at, and version 15 publishes it:

```json
"majority_judgment": { "grade_quantile": { "numerator": 3, "denominator": 5 }, … }
```

This verifier recomputes each document's grades **under that document's own fraction**. A document
publishing one-half settles its candidates at one-half, and a verifier applying three-fifths to it
would be checking its own assumptions rather than the document. An absent field — every v14
document — means three-fifths, which is what the engine of that vintage applied; absence is not a
licence to have applied something unannounced, it pins the recomputation to three-fifths and a
tally settled at anything else reports as a figure difference.

It is an exact **fraction**, never a decimal, and one written as a decimal is refused as malformed.
0.6 has no exact binary representation, and the comparison the quantile describes —
`at_or_above * denominator >= cast * numerator` — is one a challenger must reproduce without ever
dividing. Landing exactly on the quantile resolves upward, exactly, for the same reason.

## An invalid Majority Judgment ballot is not Participation

Under MJ a ballot grades **every** candidate exactly once. One that does not is *invalid*, not
partial — and from version 15 its weight reaches nothing at all: no option total, no
`total_weight`, no `abstain_weight`, no `voter_count`, no grade, no candidate's `cast`.
Participation is the total power of valid ballots only (On-Chain Identifiers & Verification Policy
§4; Proposal & Voting Framework §6.3). Before this, a malformed ballot's weight counted toward
`total_weight` and could therefore carry an election over its quorum without expressing a single
grade.

It is still **reported**, by index, in `majority_judgment.invalid_ballots` — which is the whole
difference between an invalid ballot and a barred one. A barred ballot is struck first and never
reaches the validity check, so it is never named there: it was not eligible to be judged, and an
index in that list must not accuse a voter of malformity on a ballot nobody read.

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
| 4 | **Malformed** — the input is not a readable tally document, or its own register names something the ledger says it is not |

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
