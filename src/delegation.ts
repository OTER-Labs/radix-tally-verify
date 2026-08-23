/**
 * The DELEGATION leg (tally document v18): one account's weight cast by another's ballot.
 *
 * Every leg before this one answered "how much is this account's balance worth". This one
 * answers a different question — "whose ballot may carry it" — and it is the first rule in the
 * document where weight and ballot belong to two different accounts.
 *
 * ## What this verifier recomputes, and what it takes as given
 *
 * The leg has two halves, and only one of them is derivable from Gateway state.
 *
 *   * **The snapshot half** — which delegations were in force at `snapshot_state_version`, and
 *     which delegates had declined — is a fold over the delegation component's whole write
 *     history, ordered by `(state_version, sequence)`. That history reaches the reference engine
 *     through an event indexer, not through the Gateway's historical state endpoints, so this
 *     verifier cannot reproduce it without becoming an indexer. The document publishes the
 *     result as `delegation_input`, and this verifier treats it as an INPUT — the same class as
 *     the ballots themselves and `excluded_accounts`, and covered by the hash exactly as they
 *     are.
 *
 *   * **The resolution half** — which of those delegations actually moved weight, why the rest
 *     did not, how much each was worth, and what that does to every total and to the verdict —
 *     is a pure function of `delegation_input`, who voted, `excluded_accounts`, and the
 *     recomputed weights. All of it is recomputed here, and every published figure that depends
 *     on it is compared.
 *
 * That split is stated in the README's coverage table rather than buried, because a verifier
 * that is vague about which of its inputs it checked is worse than one that checks less.
 *
 * ## The rule
 *
 * ONE HOP, never transitive: A→B→C leaves A's weight with B. A direct ballot revokes (an empty
 * ballot is a ballot; an MJ-invalid ballot is a ballot). A delegation lands on a BALLOT or
 * nowhere — a delegate who did not vote, is barred, or has declined receives nothing, and the
 * weight does not fall back to the delegator. `excluded_accounts` is enforced on the delegation
 * GRAPH, before resolution, not on the totals after: a bar applied only to ballots would stop a
 * barred account voting and then let the same balance vote through a delegate, re-enfranchising
 * exactly what charter §5 removes.
 */

import { Dec } from "./decimal.ts";

/**
 * A delegation IN FORCE at the snapshot, before anything that depends on who voted — the
 * document's `delegation_input`.
 */
export interface SnapshotDelegation {
  delegator: string;
  delegate: string;
  /** Whether the DELEGATE had declined delegated weight as of the snapshot. */
  delegateDeclined: boolean;
}

/**
 * Why a delegation in force did not move any weight. These are the stable tokens the document
 * publishes in `delegations[].reason`; a challenger compares them literally.
 */
export type DelegationRefusal =
  | "excluded_delegator"
  | "self_delegation"
  | "delegator_voted"
  | "delegate_declined"
  | "excluded_delegate"
  | "delegate_did_not_vote";

export const DELEGATION_REFUSALS: readonly DelegationRefusal[] = [
  "excluded_delegator",
  "self_delegation",
  "delegator_voted",
  "delegate_declined",
  "excluded_delegate",
  "delegate_did_not_vote",
];

/** A delegation in force at the snapshot, resolved against who actually voted. */
export interface ResolvedDelegation {
  delegator: string;
  delegate: string;
  /** `null` = the delegation is EFFECTIVE and the delegator's weight rides the delegate's ballot. */
  refusal: DelegationRefusal | null;
}

/**
 * **The delegation rule, in one pure function.** No gateway, no clock: a challenger with the
 * same three inputs lands on the same list.
 *
 * `voted` is the set of accounts with a ballot on this consultation, INCLUDING barred ones. A
 * barred account's ballot is not a vote, but it is still an act by that account's owner, and the
 * two roles it plays here differ. As a DELEGATOR, casting it revokes (though the bar refuses the
 * delegation first anyway). As a DELEGATE, having cast it buys nothing, because the bar refuses
 * the delegation before the ballot is even looked at.
 *
 * The order of the tests decides only which reason is REPORTED, never the outcome — but the
 * reported reason is the thing a reader checks, so the bar is tested first: when the DAO's own
 * funds are involved, that is the fact worth publishing, whatever else is also true of the
 * record.
 *
 * This function never follows `delegate` onward. That is the whole of the transitivity decision,
 * and it is here so that changing it would be a change to this function and to one clause of the
 * weight rule, and to nothing else.
 */
export function resolveDelegations(
  snapshot: SnapshotDelegation[],
  voted: Set<string>,
  barred: Set<string>,
): ResolvedDelegation[] {
  return snapshot.map((d) => {
    let refusal: DelegationRefusal | null;
    if (barred.has(d.delegator)) {
      refusal = "excluded_delegator";
    } else if (d.delegator === d.delegate) {
      refusal = "self_delegation";
    } else if (voted.has(d.delegator)) {
      refusal = "delegator_voted";
    } else if (d.delegateDeclined) {
      refusal = "delegate_declined";
    } else if (barred.has(d.delegate)) {
      refusal = "excluded_delegate";
    } else if (!voted.has(d.delegate)) {
      refusal = "delegate_did_not_vote";
    } else {
      refusal = null;
    }
    return { delegator: d.delegator, delegate: d.delegate, refusal };
  });
}

export function counted(d: ResolvedDelegation): boolean {
  return d.refusal === null;
}

/**
 * Delegated weight per DELEGATE, and the total that reached a ballot.
 *
 * Only effective delegations land here, so a barred delegator's weight is ABSENT rather than
 * zeroed — it never enters the arithmetic at all.
 *
 * Conservation: each delegator has at most one delegation in force, an effective one adds weight
 * only to a ballot, a delegator who voted keeps their own weight, and nothing is forwarded. So
 * every account's weight is counted at most once, and the resolution terminates for any input —
 * including a ring of any length — because there is no traversal to terminate.
 */
export function delegatedWeightByDelegate(
  resolved: ResolvedDelegation[],
  weights: Map<string, Dec>,
): { byDelegate: Map<string, Dec>; total: Dec } {
  const byDelegate = new Map<string, Dec>();
  let total = Dec.ZERO;
  for (const d of resolved) {
    if (!counted(d)) continue;
    const w = weights.get(d.delegator) ?? Dec.ZERO;
    byDelegate.set(d.delegate, (byDelegate.get(d.delegate) ?? Dec.ZERO).add(w));
    total = total.add(w);
  }
  return { byDelegate, total };
}
