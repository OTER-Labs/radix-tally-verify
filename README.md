# radix-tally-verify

Independently recompute a Radix governance consultation's tally from Gateway state, and check it
against the hash committed on-ledger.

**Status: working. Supported tally document version: 22 (21 was never issued); supported mirror
block version: 3, Temperature Check, Proposal and both Majority Judgment rounds.** The full
pipeline exists: weight recomputation from Gateway historical state, verdict re-derivation,
canonical re-serialization, and the hash check, behind a CLI whose exit codes distinguish the
three outcomes above.

No **tally** document is refused for its `tally_doc_version`. Verification is driven by field
presence, so one written before any given leg existed takes the absent-means-off path on each
field and verifies exactly as it did before that leg was added. A **mirror** document is
version-checked: `mirror_doc_version` 1 and 2 are refused, because each states a different
official rule that cannot be recomputed under v3's. The tally version number itself is read for
one purpose only: the v19→v20 verdict change is a *comparison* rather than a field, so each
document's `approved` is recomputed under the bar in force when it was settled — see
[the approval bar](#the-approval-bar-is-at-or-above).

The reads are fail-closed. An entity-details answer that leaves out a preallocated voter account,
or that answers at a different state version than the read asked for, is an error rather than a
zero. A resource's missing `symbol` metadata is an error unless the resource answered and
declares no symbol. Membership weight comes from the collection amount, never from local ids an
opt-in may have silently emptied.

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
   document's own source register says counts. Every state read must answer at the state version
   it asked for, and a preallocated account must appear in the answer.
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
  the state endpoints the weight rule and the mirror reads need. It refuses an answer that
  carries no ledger state, or that answers at another state than the one asked for.
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
- **`src/mirror.ts`**, **`src/allowlist.ts`** and **`src/framework.ts`** — mirror-tally
  verification (`ballot_source` present): re-reading the official Radix DAO component's own
  ballots and vote metadata, recomputing the Consultation App's own rule from the static allowlist
  this package ships under `data/`, the outside-window count, the per-source gap between the two
  rules, and the governance framework's bar (eligible voting power, MAS, the voter floor) for the
  vote's parameter set. Majority Judgment rounds are read from their own register and published as
  Elections. See "Mirror tallies" below.
- **`src/weight-rule.ts`** — the rule in words for each space configuration, checked against the
  document's `weight_rule`, and the register each `weight_config` implies.
- **`src/verify.ts` / `src/cli.ts`** — orchestration and the command line. `--mirror` is not a
  flag: a document carrying `ballot_source` gets the extra checks automatically.
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
| **Fungible space** | 22 | the account's balance of the ONE resource `weight_config` names — replaces the whole sum above, not a leg on top of it | recomputed |
| **Membership space** | 22 | 1-or-0 per account (≥1 non-fungible of the named resource held), read from the collection amount at Global aggregation and replacing the sum above the same way | recomputed |

And the verdict, in full: quorum on both legs, the Binding gates, the DAO-controlled-funds bar,
Majority Judgment's qualifying grades and gauges at the document's own quantile, `invalid_ballots`,
the withdrawn-candidate exclusion, and every seat allocation.

A **mirror** document runs every leg above twice — once under the register it carries, as scoped
to the official component's network (check (g)), once under the official Consultation App's own
allowlist — and resolves no delegation at all. See "Mirror
tallies" below.

## Spaces (tally document v22)

A consultation now belongs to a **space** — a self-contained electorate inside the one registry,
with its own immutable weight rule. Space `0` is the Radix/XRD space every consultation lived in
before spaces existed, and it is also what an absent `space_id` means: a v20 document verifies
exactly as it always did.

Four keys, all additive, all absent-means-default:

| Field | Type | Meaning |
|---|---|---|
| `space_id` | number | `0` = the Radix/XRD space. Absent = `0`. |
| `weight_config` | object | `{"kind":"Xrd"}` \| `{"kind":"Fungible","resource":…}` \| `{"kind":"Membership","resource":…}`. **The `Xrd` form has no `resource` key at all** — an absent field, not a null. Absent = `{"kind":"Xrd"}`. |
| `term_seconds` | number | An Election's seat term. `0` elsewhere, and absent = `0`. |
| `asset_symbol` | string | The weighed resource's `symbol` metadata, read **at `snapshot_state_version`** (not "now" — metadata is mutable, and a later rename must not move a settled hash). `"XRD"` for the `Xrd` rule, which sums many resources and has none to read one from. Absent = `"XRD"`. |

`weight_sources` gains two more legs under the same `skip_serializing_if`-style discipline every
post-v15 leg has — present only on a consultation of that kind of space, absent (and therefore off)
everywhere else:

- **`fungible: {resource}`** — a `Fungible` space's weight is the account's balance of that ONE
  resource at the snapshot. Nothing else counts: no XRD, no LSUs, no pools, no supplementary
  register. Because the weight is a transferable balance, it is buyable — the levers against that
  are the space's absolute `min_binding_quorum`, its recall path, and choosing a Membership space.
- **`membership: {resource}`** — a `Membership` space's weight is `1` if the account holds at
  least one non-fungible of that resource at the snapshot, `0` otherwise, **however many it
  holds**. The count is read from the collection's own `amount` at Global aggregation, not from
  local ids: those ids exist only because of an opt-in, and an opt-in the Gateway silently stops
  honouring would make every member weigh zero with no error anywhere. Whoever controls the
  resource's mint controls the electorate.

Both legs **replace** the ordinary XRD sum rather than adding to it — a Fungible or Membership
document's `xrd`, `lsu`, `pool_units`, `lsulp`, `precision_pools` and `shape_pools` legs are all
zero, and `computeAccountWeightBreakdown` short-circuits before touching validators or pools at
all. **Delegation is the one exception**: it survives into every space unchanged, because it
answers "whose ballot may carry this weight", which is orthogonal to what the weight function
means — a member delegating to another member is the same act whatever the weight rule is.

`asset_symbol` is **checked, not merely carried**: the named resource's `symbol` metadata is
re-read at the same `snapshot_state_version` (the `Xrd` rule costs no Gateway call — its answer
is the literal `"XRD"`) and compared against the document's claim. A mismatch is a figures-class
finding, exactly like a wrong weight. The read is matched by address, and it fails closed: an
answer with no item for that resource, or with no `explicit_metadata` block at all, is MALFORMED.
The empty string means one thing only — the resource answered and declares no symbol.

`weight_rule` is checked too: when the document carries it, it must equal the text its own
`weight_config` implies, and a different sentence is a figure difference. `weight_sources` must
equal the register that config implies — a `Fungible` or `Membership` document carries its one
space leg and none of the XRD-priced valuation legs, while an `Xrd` document carries neither
space leg.

No verdict logic changed: quorum, the approval bar, seat allocation and Majority Judgment are
identical whichever config produced the weights they operate on. `src/mirror.ts` is unaffected —
a mirror document carries the four keys as the space-0 constants, exactly like a Poll's, since a
mirror consultation lives in the Radix/XRD space.

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
- **`weight_set_version` and `excluded_set_version`** (v19) — the versions the registry pinned.
  This tool reads Gateway state, not the registry, so it cannot fetch those sets by version on its
  own. Supply them with `--weight-set` and `--excluded-set` and both the version and the list the
  document embeds are checked against the registry's set: the register against
  `weight_sources`, the barred accounts against `excluded_accounts`. Without the files, both are
  carried and hashed but not checked. For a mirror document, `--weight-set` also supplies the
  register check (g) derives the document's scope from.

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
reaches the validity check, so it is never named there: it was not eligible to be checked, and an
index in that list must not accuse a voter of malformity on a ballot nobody read.

## Mirror tallies of official Radix DAO votes

For every Temperature Check, Proposal and Majority Judgment round on the official Radix DAO
Consultation App component, OTER can publish a document that reads the SAME on-chain ballots and
tallies them twice: under the **official rule** — the Consultation App's own policy, which
reproduces their published number and so proves the same ballots were read — and under the
**OTER rule**, that platform's own `WEIGHT_RULE`. A Temperature Check and a Proposal take ONE
bar, the official vote's own: the absolute `quorum` and `approval_threshold` of its parameter
set, plus the governance framework's Minimum Affirmative Support (MAS) and distinct-voter floor
for that set. A Majority Judgment round takes its round's absolute `quorum` and the framework's
`dao-election` percentages, and seats candidates rather than deciding an approval ratio. The
DAO-controlled-funds bar (`excluded_accounts`) belongs to the OTER rule alone: the official vote
has no such bar, so the official rule counts every ballot — a barred account's included — toward
its totals, its `total_weight` and its voter count, exactly as the Consultation App does. Beyond
that bar, the only thing the two results can disagree about is the weight function.

The official component is the Radix DAO `Governance` 1.0.0 blueprint. Each vote carries its own
snapshot of a **parameter set** (`id`, `label`, `version`, and a `Standard` or `MajorityJudgment`
variant holding a `temperature_check` leg and, under `Standard`, a `proposal` leg, and under
`MajorityJudgment` an `election` leg); a Temperature Check or Proposal reads its `quorum` and
`approval_threshold` off its own leg, and a Majority Judgment round reads its own round's
`quorum`. This verifier checks all four kinds: Temperature Check, Proposal,
`majority_judgment_election` and `majority_judgment_election_rerun`.

### What the official rule is

The Consultation App states it on `vote.radixdao.org/about/voting-power`. At the snapshot it
counts, and values in XRD:

1. **direct XRD** — "1 XRD equals 1 vote";
2. **validator LSUs** — the stake units of every validator at their underlying XRD value. The
   app's page says "active", but the rule as applied has no list and no activity filter, and
   neither does this verifier; the document's rule text says "the stake units of every
   validator";
3. **LSULP** — at its underlying liquid-staked XRD value;
4. **a static allowlist of DEX liquidity positions** — "This is the current static allowlist used
   when a vote is snapshotted." Only the XRD, LSU or LSULP side of a position counts; the other
   token in the pair adds nothing.

(1) and (2) are the governance framework's Tier 1 and cannot be removed; (3) and (4) are its
Tier 2, changeable by the DAO's own process. The list behind (4) is hard-coded in the app's
JavaScript bundle rather than published as a file, so this package ships a transcription of it:

```
data/official-allowlist.mainnet.json    69 entries — the LSULP pair plus the app's 68 positions:
                                        Ociswap V1 4 + V2 10 precision receipts, Ociswap Basic 4
                                        + Flex 1, CaviarNine Simple 11 + HLP 1 pool units,
                                        CaviarNine Shape 15 receipts, DefiPlaza Base 11 + Quote 11
data/official-allowlist.stokenet.json   empty — none of those DEXes deploys to the test network,
                                        so the official rule there is XRD + validator LSUs alone
```

Which file applies is decided by the official component's own bech32 prefix, so the ballots, the
balances and the allowlist always come from one network with nothing to configure.

**The list travels with the verifier, never with the document.** A mirror document names the list
it was weighed under — `official_rule.allowlist_version` and `allowlist_hash`, a blake2b-256 over
the canonical JSON of the list's `entries` — and check (b) recomputes that hash from this
package's own copy. A verifier that took the list from the document would be checking a claim
against itself. When the app changes its allowlist, a new version of this package ships a new
file, and documents weighed under the old list stop verifying against the new one; that is the
correct outcome, and it is why the version is published at all.

### The document block

This is **additive** — no `TALLY_DOC_VERSION` bump. A mirror document carries everything an
ordinary v22 document does (`votes`, `totals`, `total_weight`, `quorum`, `approved`, …), holding
the OTER-rule result exactly as an ordinary Poll would, plus one extra block:

```json
"eligible_voting_power": "…",
"ballot_source": {
  "mirror_doc_version": 3,
  "component": "component_rdx1…", "blueprint": "Governance",
  "kind": "temperature_check" | "proposal"
        | "majority_judgment_election" | "majority_judgment_election_rerun", "official_id": 5,
  "official_start": 1784999200, "official_deadline": 1785431200,
  "official_snapshot": 1784999200,
  "official_quorum": "402876916", "official_approval_threshold": "0.5",
  "official_parameter_set": { "id": "default", "label": "Standard Executable",
                               "version": 1, "variant": "Standard" },
  "official_outcome": { "result": "Passed", "recorded_at": 1785431500 } | null,
  "official_continuation": { "kind": "proposal", "id": 6 } | null,
  "official_max_selections": null,
  "official_vote_count": 51, "official_revote_count": 3,
  "ballot_count": 48, "ballot_state_version": 542970896, "ballots_outside_window": 0,
  "official_entry_state_version": 543104118,
  "official_rule": { "rule": "The Radix DAO Consultation App's own rule at snapshot_state_version: …",
                      "allowlist_version": "2026-09-06", "allowlist_hash": "bfadafb5…",
                      "totals": ["…", "…"], "total_weight": "…",
                      "totals_by_source": { "liquid": "…", "lsu": "…", "lsulp": "…",
                                            "pool_units": "…", "precision_pools": "…",
                                            "shape_pools": "…" },
                      "quorum_met": true, "approved": true | null },
  "weight_delta_by_source": { "lsu": "…", "pool_units": "…", "lsulp": "…",
                               "precision_pools": "…", "shape_pools": "…" },
  "framework": { "source": "RadixDAO/governance-framework@470a047 Parameters Registry §3.2, §3.3A, §8A",
                 "quorum_pc": "3", "mas_pc": "0", "min_unique_voters": 0,
                 "eligible_voting_power_derivation": "quorum * 100 / quorum_pc (…)",
                 "eligible_voting_power_bound": "33.333333333333333333" } | null,
  "oter_register_scope": "full" | "network_independent",
  "official_round": "RoundOne" | "Rerun",            // Majority Judgment only
  "official_role_id": "rac-seat",                    // Majority Judgment only
  "official_candidate_references": ["candidate-…"],   // Majority Judgment only
  "official_tie_resolution": [2, 1, 0] | null          // Majority Judgment only
}
```

A Majority Judgment document is an Election: `kind` is `"Election"`, `seat_rule` is
`"MajorityJudgment"`, `seats` is the election's seat count, `final_seats` is `0`,
`withdrawn_excluded` is `[]`, `approve_weight` / `reject_weight` / `approved` / `mas_met` are
null, and `winners` and `majority_judgment` carry the OTER leg's seating. Its
`official_rule` gains `winners` and `majority_judgment` for the official leg, and publishes
`totals_by_source` and `weight_delta_by_source` as null. The four `official_*` keys above are
written on every Majority Judgment document, and a missing one is MALFORMED.

`official_snapshot` is the Instant the weight snapshot anchors to: a Temperature Check's or a
Majority Judgment round's own `snapshot` field, a Proposal's `start` (a Proposal carries no
snapshot of its own).
`official_outcome` and `official_continuation` are a Temperature Check's recorded result and what
it was elevated to (`proposal` or `majority_judgment_election`); both are null on a Proposal.
`official_max_selections` is a Proposal's `max_selections` (null when single choice, and on every
Temperature Check and Majority Judgment round). Every v3 key is written on every v3 document; a
missing one is MALFORMED, never read as null.

`official_entry_state_version` is the state version at which the official entry was read: the
entry's own `last_updated_at_state_version`. It is an integer on every v3 document, of every kind;
a missing or non-integer value is MALFORMED, naming the key. The document carries two read points
because the entry and its ballots change at different times. A Temperature Check records its
`outcome`, and any `continuation`, after its deadline, so after its last ballot, and the entry as it
stood at `ballot_state_version` carries neither. Check (a) therefore reads the entry at
`official_entry_state_version` and the `voters` store at `ballot_state_version`. The entry read at
`official_entry_state_version` must exist and must be the vote the document names; nothing else is
required of how the two versions are ordered.

`oter_register_scope` says how much of the weight-source register the OTER-rule leg applied, and
is always present: exactly `"full"` or `"network_independent"`, and anything else, absence
included, is MALFORMED. The register is a registry's on-ledger set, and every entry it names — an
LSULP pair, a native, precision or shape pool, a delegation component — is an address on the
registry's network. A mirror is weighed on the official component's network, so when the two
differ those addresses do not exist on the ledger being read:

- `"full"` — the component is on the registry's network. The register applies whole, with
  delegation off (a mirror resolves none).
- `"network_independent"` — the component is on another network. Every leg that names an address
  is off: `lsulp`, `precision_pools`, `shape_pools`, and a `native_pools` allowlist, which turns
  off rather than widening into discovery. `native_pools` in mode `all` stays, since discovery
  names nothing. Direct XRD and every validator's stake units count as always.

`weight_set_version` still names the full set; `weight_sources` carries the register as applied,
so under `"network_independent"` it names no address. See check (g) below.

**The framework bar.** The on-chain parameter sets carry absolute quorums and no MAS; the
governance framework's Parameters Registry fixes each set's quorum and MAS as percentages of
**eligible voting power**, a figure nobody publishes. So it is derived, in the same truncating
18-decimal arithmetic as everything else here:

| parameter set | proposal quorum % | MAS % | min unique voters |
|---|---|---|---|
| `default` | 5 | 1 | 0 |
| `dao-constitutional` | 10 | 3.5 | 0 |
| `dao-governance` | 7 | 2 | 0 |
| `dao-treasury` | 7 | 1.5 | 50 |
| `dao-election` | 7 | 0 | 0 |

The `dao-election` row is the Majority Judgment election row, not a proposal row: a Proposal
under that set gets no bar, and a round under any other set gets none either. A Temperature
Check is 3 % under every set, with no MAS and no floor. `eligible_voting_power =
quorum * 100 / quorum_pc` for the vote's own leg, and `min_affirmative_support = eligible * mas_pc
/ 100`. Because the DAO truncated its absolute quorums to whole XRD, the derived figure is a lower
bound: the true one lies in `[derived, derived + 100/quorum_pc)`, and that width is published as
`eligible_voting_power_bound`. A Proposal under a set this table does not name gets no bar and no
verdict: `eligible_voting_power` `"0"`, `framework` null, and `approved` / `mas_met` null on both
legs.

**Sides by label, never by position.** A Temperature Check's sides are For (index 1) and Against
(index 0). A Proposal has sides only when it is single choice and its option labels — trimmed,
ASCII case-insensitive — are exactly `Approve`, `Reject` and optionally `Abstain`, each once, in
any order. The labels are the ones the Proposal carries on chain: its `vote_options`, read from
the entry at `official_entry_state_version` and placed by their `ProposalVoteOptionId`, the index
every ballot's selection names. The document's `options` must equal them verbatim (check (a),
reported as `ballot_source.(a) options`), and the sides never come from the document: ballots
match by index, so a document with Approve and Reject swapped would otherwise re-derive its own
inverted verdict and agree with itself. "Trimmed" strips ASCII whitespace from both ends and nothing else: U+0020 space, U+0009
tab, U+000A line feed, U+000C form feed and U+000D carriage return. Common library trims strip
wider Unicode sets, and different languages strip different ones, so a label wrapped in any other
character (U+FEFF, U+0085, U+000B, U+00A0, …) is not one of the three words and the Proposal decides
nothing; any other label set, and any multi-select Proposal, publishes `approve_weight`,
`reject_weight`, `mas_met` and `approved` as null. Abstain counts toward quorum (it is in
`total_weight`) and toward `abstain_weight`, and stays outside the decisive share. Both legs apply
the whole bar: the quorum, the at-or-above threshold, MAS, and the distinct-voter floor. A
Majority Judgment round has no sides: its ballots grade every candidate, its outcome is a
seating, and its `approve_weight` / `reject_weight` / `approved` / `mas_met` are null on both
legs.

`weight_delta_by_source` is **OTER-rule weight minus official-rule weight, per source**, over the
accounts whose weight entered the OTER total. Every leg is zero on a source where the DAO's
on-ledger register and the app's allowlist name the same positions — which, on mainnet as of the
version shipped here, is all of them. The values are signed: positive where the register counts a
position the allowlist does not, negative the other way round. There is no `liquid` leg, because a
balance is not a listed source and both rules count it at par. A Majority Judgment document
publishes the delta as `null`: its official result is a seating, not an approval split.

**Only `mirror_doc_version` 3 is checked; 1 and 2 are refused, not checked.** Version 1 documents
state the official rule as liquid XRD only. Version 2 documents were read from the pre-1.0.0 flat
official entry, with positional sides and a bar without MAS. Recomputing either under the rule
above would compare a number against a rule that did not produce it, and every difference
reported after that would say more about the verifier than about the document.

**Its presence is the switch.** There is no `--mirror` flag: `radix-tally-verify` runs exactly as
above, and a document carrying `ballot_source` gets seven checks instead of one:

| Check | What it does | Where a mismatch is reported |
|---|---|---|
| **(a)** the ballots | Re-reads the official component's own state — `temperature_checks` / `proposals` / `majority_judgment_elections` key-value store → the entry named by `official_id`, at `official_entry_state_version` → its `voters` key-value store, at `ballot_state_version` — and compares every account's selection, plus the entry's own metadata, against what `ballot_source` claims: `quorum` / `approval_threshold` of its parameter-set leg, the set's `{id, label, version, variant}`, `start` / `deadline` / `vote_count` / `revote_count`, a Temperature Check's `snapshot`, `outcome` and `continuation`, a Proposal's `max_selections`, and the on-chain option labels against the document's `options`. A Majority Judgment round is read from its election's `round_one` / `rerun`, and its parameter set, candidates, `role_id` and seat count from the Temperature Check that carries them; `official_round`, `official_role_id`, `official_candidate_references`, `official_tie_resolution` and `seats` are compared too. It also checks the weight snapshot's anchor: `snapshot_state_version` must equal the state version the Gateway's timestamp selector resolves the entry's snapshot Instant to (a round's own `snapshot`, a Proposal's `start`) — see below | `ballot_source.(a) …`; the labels as `ballot_source.(a) options`; the anchor as `ballot_source.(a) snapshot_state_version` |
| **(b)** the official rule | Checks `allowlist_version` / `allowlist_hash` against this package's own copy of the list, then recomputes the app's policy — direct XRD, every validator's LSUs, LSULP and the allowlisted positions — at `snapshot_state_version` with the same weight engine check (c) uses, handed the allowlist as its register; summed per option over every ballot, barred accounts included, and decided under the same bar and the same label sides as the OTER rule (quorum, threshold, MAS, voter floor); compared against the claimed totals, verdict and `totals_by_source` split. For a Majority Judgment round it recomputes the official leg's totals over valid ballots, its quorum, and its seating under the round's own floor, then compares `official_rule.winners` and `official_rule.majority_judgment` | `ballot_source.(b) official_rule. …` |
| **(c)** the OTER rule | The ordinary v20 pipeline above, completely unchanged — this is why a mirror document's top-level fields are checked exactly as a Poll's would be | the usual unprefixed field names (`totals[…]`, `votes[…].weight`, `approved`, …) |
| **(d)** the window | How many re-read ballots landed before the vote's own start or after its deadline, both bounds resolved from `official_start` / `official_deadline` via the Gateway's timestamp selector — see below | `ballot_source.(d) ballots_outside_window` |
| **(e)** the weight delta | The per-source gap between the two rules — OTER-rule weight minus official-rule weight over the same participating accounts, both sides from the same weight engine over the same account set. Zero wherever the register and the allowlist agree; signed where they do not. A Majority Judgment round publishes no delta, and the check requires its claim to be null | `ballot_source.(e) weight_delta_by_source. …` |
| **(f)** the framework bar | Re-derives eligible voting power, MAS and the voter floor from the RE-READ parameter-set id and quorum (never the document's) and compares them against the top-level `eligible_voting_power`, `min_affirmative_support` and `min_unique_voters`, and the framework row against `ballot_source.framework` | `ballot_source.(f) …` |
| **(g)** the register scope | Expects `oter_register_scope` `"full"` exactly when the bech32 network of `ballot_source.component` equals the network of the registry whose set `weight_set_version` names, else `"network_independent"`; derives the applied register from that set (delegation off, and under `"network_independent"` every named leg off) and requires `weight_sources` to equal it canonically. The OTER leg in (c) and (e) is weighed under this derived register, never the document's, so no register address reaches the other network's gateway — see below | `ballot_source.(g) …` |

Every mismatch is still an ordinary `Difference` in the same `figures` outcome the rest of this
tool uses — there is no separate mirror outcome kind. The prefix names which of (a)–(g) is wrong
without inventing a second vocabulary for it.

Because both legs now go through one weight engine and differ only in the register handed to it,
a difference between them is attributable: it is the two lists disagreeing, not two
implementations of arithmetic disagreeing.

A Proposal without decision sides — another label set, or a multi-select — is not refused: its
totals, `total_weight` and `quorum_met` are recomputed and compared on both legs as usual, and its
verdict fields are checked to be null.

**`ballots_outside_window` is ported from the reference engine, not approximated.** Both window
bounds are resolved from `official_start` / `official_deadline` — timestamps — via the Gateway's
timestamp selector (`POST /state/entity/details` with `at_ledger_state: { timestamp }`, XRD as the
anchor address since any well-known entity works and its data is never read): the SAME call the
engine's own state-version lookup makes, and the SAME comparison its outside-window count makes
— a ballot's own
`last_updated_at_state_version` outside `[start_state_version, deadline_state_version]` counts as
late. `deadline_state_version` is unbounded while `official_deadline` is still in the future (the
engine's own unbounded `deadline_state_version` sentinel): there is no ledger state after a future
deadline to
resolve, so an open vote reports zero late ballots rather than every ballot as late.

The window opens at the vote's own `start`, for every kind — never at `official_snapshot`. The
snapshot fixes the weights and nothing else. For a Proposal and a first round the two are the same
instant; a Majority Judgment rerun weighs at round one's snapshot but opens for ballots at its own
start, so a ballot cast between the two lies outside its window.

**The snapshot anchor is checked through the same selector.** Both legs are weighed at the
top-level `snapshot_state_version`, so that number decides every weight in the document. Check (a)
resolves the entry's own snapshot Instant (a Temperature Check's or Majority Judgment round's
`snapshot`, a Proposal's `start`) to a state version with the timestamp selector above and
requires `snapshot_state_version` to equal
it. A document weighed at any other state version — at a Temperature Check's `start` instead of its
`snapshot`, say — is internally consistent and would otherwise recompute cleanly; this check names
it as `ballot_source.(a) snapshot_state_version`. When the snapshot Instant is the start, the
window's lower-bound lookup answers both.

An earlier version of this check bounded the window by `[snapshot_state_version,
ballot_source.ballot_state_version]` instead — reusing two state-version anchors the document
already carries, to avoid a second Gateway call shape. That was wrong: `ballot_state_version` is
*defined* as the max `last_updated_at_state_version` actually observed across the polled ballots,
so no ballot can ever exceed it, and the check could never flag a late one — a correct engine
reporting `ballots_outside_window = 1` would have been contradicted by the verifier. Ported
instead of reused, matching the engine exactly.

**Check (g) needs the registry's network, and this tool reads the Gateway, not the registry.**
Given `--weight-set`, the set and its network come from that file: `weight_set_version` must equal
the file's, the expected scope follows from the two networks, and the register the document must
carry is derived from the file's set. Without it, the document's own `weight_sources` stands in for
the set: any address it names is a registry entry, so its network is the registry's (a register
naming addresses on two networks is MALFORMED), and a `"full"` document naming another network's
pair is caught by name. A register that names nothing leaves the registry's network unknown; the
claimed scope then stands, and the derived register names nothing, so the weights recomputed are
the same under either scope. What that case cannot confirm is that a set with named legs was
scoped correctly — the `weight_set_version` gap below, closed by supplying the set.

### Worked example: mainnet Temperature Check #5

Live-fetched against `https://mainnet.radixdlt.com`, 2026-08-29 (state version ≈556,518,680).
This is the Consultation App's earlier `Governance` component, whose entries carry `quorum` and
`approval_threshold` flat on the entry; a `Governance` 1.0.0 entry carries them on its own
parameter-set leg instead, alongside its `snapshot`, `outcome` and `continuation`:

```
component_rdx1czn9hrgd30x742k6jw2e6psj9jlkqvu2cj4hcry60p7f38hxd3k3xt   Governance
  temperature_checks -> internal_keyvaluestore_rdx1kzz2u0294msyxj30haskqnkt0akuull8r8533pxc5af8plqtyfg09v
    entry 5 -> voters:  internal_keyvaluestore_rdx1kq3ehgahlcn3jwcv33aqhmjqmf8r9tcsmyvvqj6cvmyhdm6u925vpv
              quorum: 402876916   approval_threshold: 0.5
              start: 1784999200   deadline: 1785431200
              vote_count: 51      revote_count: 3
              last_updated_at_state_version (of the entry itself): 542970896
    voters KVS -> 48 entries (total_count), e.g. account_rdx128kcvrsc8y2d24qnuxekkj4vlfj8zuwv8g62anh203zkqlzlqym2rt
              -> { vote_id: 50, vote: For (variant 0) }, last_updated_at_state_version 542970896
```

`For` is variant 0 and `Against` is variant 1 in the official component's own enum — the OPPOSITE of
the Poll option order `["Against", "For"]` a mirror document publishes, so `src/mirror.ts` inverts
the mapping: `For -> [1]`, `Against -> [0]`.

The official Consultation App's own published result for this vote (a cross-check only, from
`https://api-consultation.mountain-top.live/vote-results?type=temperature_check&entityId=5`, not
something this tool reads) was `Against: 1,396,027.35…`, `For: 670,857,540.02…` — comfortably over
quorum (402,876,916) and about 99.8% approval, so `official_rule.approved` would be `true`. The
`totals` / `total_weight` / `totals_by_source` / `weight_delta_by_source` figures in a real mirror
document for this vote come from running `computeAccountWeightBreakdown` over all 48 accounts at
the snapshot twice, once under each register — not reproduced by hand here, and marked as
**example values** in the `ballot_source` block above rather than presented as if they were
live-computed.

Note that this vote is one the app itself weighed BEFORE it caught up to the policy above: the
allowlist shipped here is the one the app applies now, and a mirror of an older vote is a reading
of those ballots under today's rule rather than a reconstruction of the number published then.

## Running it

```
npm install && npm run build
radix-tally-verify <tally.json | -> [--gateway URL] [--tally-hash HEX] [--xrd-resource ADDR]
                  [--weight-set FILE] [--excluded-set FILE] [--hash-only]
```

The input may be the bare document or the API envelope (`{"document": …, "document_hash_blake2b":
…}`). The gateway defaults to mainnet; the XRD resource address follows from the gateway URL
(`mainnet` / `stokenet`), or pass `--xrd-resource` for anything else. For a mirror document, the
gateway serves the official component's network.

`--weight-set` supplies the weight-source set the document's `weight_set_version` names, and the
network of the registry that holds it:

```json
{ "network": "mainnet" | "stokenet", "weight_set_version": 7,
  "weight_sources": { "native_pools": { "mode": "all" }, "lsulp": { … }, … } }
```

All three keys are required. `weight_sources` is in the shape a tally document carries; a file
without it is refused rather than read as the default register. Every address it names must be on
the declared network, or the file is refused. The document's version is checked against the
file's, and its `weight_sources` against the register its `weight_config` derives from the set.
For a mirror document the same file supplies the network check (g) needs.

`--excluded-set` supplies the barred register `excluded_set_version` names:

```json
{ "excluded_set_version": 3, "excluded_accounts": [] }
```

The accounts must be in strictly ascending UTF-8 order, as the document's own register must be.
The document's version and `excluded_accounts` are checked against the file.

`--hash-only` skips the Gateway entirely: it prints `canonical=…` and `hash=…` for the input's
document, and exits 0 (or 2 when `--tally-hash` was supplied and does not match). It is an
encoding check, not a shape check, so an encoding vector that is not a whole tally document can be
checked with it.

Exit codes are the contract:

| Code | Outcome |
|---|---|
| 0 | **Match** — every figure recomputes exactly, and the hash agrees when one was supplied |
| 1 | **Figures disagree** — the real signal |
| 2 | **Serialization disagreement** — figures match, hash differs; a spec departure, not a lie |
| 3 | **Unknown** — gateway unreachable or the pinned state version pruned, or an answer at another state or missing a required entity |
| 4 | **Malformed** — the input is not a readable tally document, its own register names something the ledger says it is not, or a named source cannot be read |

## Running the tests

```
npm install
npm test
```

## The specification

The canonical encoding is published as a written specification alongside the reference
implementation, and `src/canonical.ts` in this package implements it from that text rather than by
copying the reference code — which is the whole point of the exercise: if the two agree, the spec
is a standard; if only one exists, the spec is a description of that one's behaviour.

Four rules make the encoding a function of the content:

1. no insignificant whitespace;
2. object keys ascending by UTF-8 **byte** sequence, at every level (not UTF-16 code-unit order,
   which disagrees above U+FFFF);
3. every quantity that is not a small integer is a JSON **string** — an 18-decimal fixed-point
   Decimal in its minimal form: no trailing zeros, no exponent, and no decimal point when there is
   no fractional part;
4. arrays keep their order — it is content, never sorted.

The hash is `blake2b-256` over the UTF-8 bytes of that form, lowercase hex.

## Scope

This verifies **consultation tally documents** — ballots, weights, gates, verdict. It does not
verify oracle requests, bonds, or dispute settlement, which are a different object with different
inputs.

## License

Apache-2.0.
