/**
 * The Radix DAO governance framework's bar for an official vote (Parameters Registry §3.2,
 * §3.3A @ RadixDAO/governance-framework 470a047), and which option of a proposal is which.
 *
 * The on-chain parameter sets carry absolute quorums and no MAS; the registry fixes each set's
 * quorum and MAS percentages. So eligible voting power is DERIVED — `quorum * 100 / quorum_pc` —
 * and is a lower bound within `100 / quorum_pc` XRD of the true figure, because the DAO truncated
 * its absolute quorums to whole XRD. This reproduces the reference engine term for term, in the
 * same 18-decimal truncating arithmetic; a set this table does not name decides nothing.
 */

import { Dec } from "./decimal.ts";
import type { MirrorKind } from "./document.ts";

export const FRAMEWORK_SOURCE = "RadixDAO/governance-framework@470a047 Parameters Registry §3.2, §3.3A, §8A";
export const ELIGIBLE_DERIVATION =
  "quorum * 100 / quorum_pc (the DAO's absolute quorums are truncated to whole XRD, so the true figure lies in [derived, derived + 100/quorum_pc))";

const PROPOSAL_ROWS: Readonly<Record<string, { quorumPc: string; masPc: string; minUniqueVoters: number }>> = {
  default: { quorumPc: "5", masPc: "1", minUniqueVoters: 0 },
  "dao-constitutional": { quorumPc: "10", masPc: "3.5", minUniqueVoters: 0 },
  "dao-governance": { quorumPc: "7", masPc: "2", minUniqueVoters: 0 },
  "dao-treasury": { quorumPc: "7", masPc: "1.5", minUniqueVoters: 50 },
};
const TEMPERATURE_CHECK_ROW = { quorumPc: "3", masPc: "0", minUniqueVoters: 0 };

export interface Framework {
  quorumPc: Dec;
  masPc: Dec;
  minUniqueVoters: number;
  eligible: Dec;
  mas: Dec;
  bound: Dec;
}

export function frameworkFor(kind: MirrorKind, setId: string | null, quorum: Dec): Framework | null {
  const row =
    kind === "temperature_check"
      ? TEMPERATURE_CHECK_ROW
      : setId !== null && Object.hasOwn(PROPOSAL_ROWS, setId)
        ? (PROPOSAL_ROWS[setId] ?? null)
        : null;
  if (row === null) return null;
  const hundred = Dec.fromInt(100);
  const quorumPc = Dec.parse(row.quorumPc);
  const masPc = Dec.parse(row.masPc);
  const eligible = quorum.mul(hundred).div(quorumPc);
  return {
    quorumPc,
    masPc,
    minUniqueVoters: row.minUniqueVoters,
    eligible,
    mas: eligible.mul(masPc).div(hundred),
    bound: hundred.div(quorumPc),
  };
}

export interface Sides {
  approve: number;
  reject: number;
  abstain: number | null;
}

/**
 * Strip ASCII whitespace from both ends of a label: U+0020 space, U+0009 tab, U+000A line feed,
 * U+000C form feed and U+000D carriage return, and nothing else. JavaScript's `trim()` and Rust's
 * `str::trim` strip different Unicode sets (one strips U+FEFF and keeps U+0085, the other the
 * reverse), so "trimmed" is pinned to this set to leave nothing for two implementations to
 * disagree about.
 */
export function trimAsciiWhitespace(s: string): string {
  return s.replace(/^[\u0020\u0009\u000A\u000C\u000D]+|[\u0020\u0009\u000A\u000C\u000D]+$/g, "");
}

/** Lower-case A-Z only, as the reference engine's ASCII lowering does. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * A Temperature Check's sides are For (1) and Against (0) in the mirror's `["Against", "For"]`.
 * A proposal has sides only when it is single choice and its labels — with ASCII whitespace
 * trimmed (`trimAsciiWhitespace`), ASCII case-insensitive — are exactly `approve`, `reject` and
 * optionally `abstain`, each once.
 */
export function decisionSides(kind: MirrorKind, options: string[], maxSelections: number | null): Sides | null {
  if (kind === "temperature_check") return { approve: 1, reject: 0, abstain: null };
  if (maxSelections !== null) return null;
  const found: Record<string, number> = {};
  for (let i = 0; i < options.length; i++) {
    const label = asciiLower(trimAsciiWhitespace(options[i] ?? ""));
    if (label !== "approve" && label !== "reject" && label !== "abstain") return null;
    if (label in found) return null;
    found[label] = i;
  }
  if (found["approve"] === undefined || found["reject"] === undefined) return null;
  return { approve: found["approve"], reject: found["reject"], abstain: found["abstain"] ?? null };
}
