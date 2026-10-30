/**
 * The box's own event stream, for `--reread-ballots` (spec §10).
 *
 * A sealed tally document publishes each counted ballot's ciphertext and the late ballots the
 * box recorded; the box's `SealedBallotCastEvent`s are the ledger's own record of the same acts.
 * Reading them back is the one check on a sealed vote that reads the LEDGER rather than the
 * document's own claims: `votes` and `late_ballots` are compared with what the box actually
 * emitted for the vote.
 *
 * The stream is the Gateway v1 `/stream/transactions` endpoint with the emitter filter OTER's
 * indexers use (`event_global_emitters_filter`), receipt events opted in. Only the named fields
 * are read, so an event gaining a field does not break this tool.
 */

import type { TallyDocument } from "./document.ts";
import { GatewayError } from "./gateway.ts";
import type { Difference } from "./verify.ts";

/** One `SealedBallotCastEvent` of a sealed ballot box, as the Gateway's programmatic JSON
 * renders it. */
export interface SealedBallotEvent {
  stateVersion: number;
  consultationId: string;
  intentHash: string | null;
  account: string;
  ciphertext: string;
  round: number;
  roundTime: number;
  timestamp: number;
}

interface JsonField {
  field_name?: string;
  value?: unknown;
  fields?: unknown[];
}

interface StreamPage {
  items?: Array<{
    state_version?: number;
    intent_hash?: string;
    receipt?: { events?: unknown[] };
  }>;
  next_cursor?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsOf(value: unknown): JsonField[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.fields)) return value.fields as JsonField[];
  const nested = value["programmatic_json"];
  if (isRecord(nested) && Array.isArray(nested["fields"])) {
    return nested["fields"] as JsonField[];
  }
  return [];
}

function fieldEntry(fields: readonly JsonField[], name: string): JsonField | undefined {
  return fields.find((field) => field.field_name === name);
}

function fieldString(fields: readonly JsonField[], name: string): string | null {
  const value = fieldEntry(fields, name)?.value;
  return typeof value === "string" ? value : null;
}

function fieldNumber(fields: readonly JsonField[], name: string): number | null {
  const value = fieldEntry(fields, name)?.value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** An address field: the Gateway renders a component/account reference either as its string or
 * as the entity's own fields. */
function fieldAddress(fields: readonly JsonField[], name: string): string | null {
  const value = fieldEntry(fields, name)?.value;
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value["entity_address"] === "string") {
    return value["entity_address"] as string;
  }
  return null;
}

function emitterAddress(emitter: unknown): string | null {
  if (!isRecord(emitter)) return null;
  const entity = emitter["entity"];
  if (isRecord(entity) && typeof entity["entity_address"] === "string") {
    return entity["entity_address"] as string;
  }
  if (typeof emitter["package_address"] === "string") return emitter["package_address"] as string;
  return null;
}

async function postStream(baseUrl: string, payload: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/stream/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "curl/8.7.1",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new GatewayError(
      `gateway unreachable at ${baseUrl}/stream/transactions: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new GatewayError(
      `gateway answered HTTP ${res.status} for /stream/transactions: ${text.slice(0, 300)}`,
      res.status,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError(`gateway returned non-JSON for /stream/transactions`, res.status);
  }
  if (isRecord(body) && typeof body["message"] === "string") {
    throw new GatewayError(`gateway refused /stream/transactions: ${body["message"] as string}`);
  }
  return body;
}

/**
 * Every `SealedBallotCastEvent` the box emitted at or after `fromStateVersion`, across pages, in
 * ascending state-version order (the endpoint's own order).
 */
export async function streamSealedBallotEvents(
  baseUrl: string,
  box: string,
  fromStateVersion: number,
): Promise<SealedBallotEvent[]> {
  const events: SealedBallotEvent[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  for (;;) {
    const body: Record<string, unknown> = {
      event_global_emitters_filter: [box],
      order: "Asc",
      limit_per_page: 100,
      opt_ins: { receipt_events: true },
    };
    if (cursor === null) {
      // Ledger state versions start at 1; the Gateway answers an empty page for 0.
      body["from_ledger_state"] = { state_version: Math.max(1, fromStateVersion) };
    } else {
      body["cursor"] = cursor;
    }
    const page = (await postStream(baseUrl, body)) as StreamPage;

    for (const item of page.items ?? []) {
      const stateVersion = item.state_version;
      if (typeof stateVersion !== "number" || !Number.isSafeInteger(stateVersion)) continue;
      if (stateVersion < fromStateVersion) continue;
      for (const raw of item.receipt?.events ?? []) {
        if (!isRecord(raw) || raw["name"] !== "SealedBallotCastEvent") continue;
        const emitter = emitterAddress(raw["emitter"]);
        if (emitter !== null && emitter !== box) continue;
        const fields = fieldsOf(raw["data"]);
        const consultationId = fieldString(fields, "consultation_id");
        const account = fieldAddress(fields, "account");
        const ciphertext = fieldString(fields, "ciphertext");
        const round = fieldNumber(fields, "round");
        const roundTime = fieldNumber(fields, "round_time");
        const timestamp = fieldNumber(fields, "timestamp");
        if (
          consultationId === null ||
          account === null ||
          ciphertext === null ||
          round === null ||
          roundTime === null ||
          timestamp === null
        ) {
          throw new GatewayError(
            `the box emitted a SealedBallotCastEvent at state version ${stateVersion} without ` +
              `the fields this tool reads (consultation_id, account, ciphertext, round, ` +
              `round_time, timestamp)`,
          );
        }
        events.push({
          stateVersion,
          consultationId,
          intentHash: typeof item.intent_hash === "string" ? item.intent_hash : null,
          account,
          ciphertext,
          round,
          roundTime,
          timestamp,
        });
      }
    }

    const next = page.next_cursor;
    if (next === undefined || next === null || next === "") return events;
    if (seenCursors.has(next)) {
      throw new GatewayError(`the event stream repeated cursor ${next}`);
    }
    seenCursors.add(next);
    cursor = next;
  }
}

/**
 * Compare the box's events for this vote with what the document publishes.
 *
 * The engine's rule is the latest TIMELY ballot per account counts, and every LATE ballot is
 * reported and counts nothing, so the reread applies the same rule before comparing: the event
 * with the greatest timestamp per account below `round_time` must be the account's `votes` row,
 * and every event at or after `round_time` must be a `late_ballots` row (and the other way
 * around). An intent hash is compared when the ledger names one.
 */
export function compareSealedBallotEvents(
  events: readonly SealedBallotEvent[],
  doc: TallyDocument,
): Difference[] {
  const sealed = doc.sealed;
  if (sealed === null || sealed.round === null || sealed.roundTime === null) {
    return [
      {
        field: "--reread-ballots",
        document: "the document has no recognised sealed block",
        recomputed: "a v23 sealed vote with a round",
      },
    ];
  }
  const round = sealed.round;
  const roundTime = sealed.roundTime;
  const diffs: Difference[] = [];
  const check = (field: string, document: string, recomputed: string): void => {
    if (document !== recomputed) diffs.push({ field, document, recomputed });
  };

  const forVote = events.filter((e) => e.consultationId === doc.consultationId);
  for (const event of forVote) {
    check(
      `event ${event.stateVersion} round`,
      String(event.round),
      String(round),
    );
    check(
      `event ${event.stateVersion} round_time`,
      String(event.roundTime),
      String(roundTime),
    );
  }

  // Latest timely ballot per account, by timestamp and then state version — the indexer's rule.
  const latest = new Map<string, SealedBallotEvent>();
  for (const event of forVote) {
    if (event.timestamp >= roundTime) continue;
    const previous = latest.get(event.account);
    if (
      previous === undefined ||
      event.timestamp > previous.timestamp ||
      (event.timestamp === previous.timestamp && event.stateVersion > previous.stateVersion)
    ) {
      latest.set(event.account, event);
    }
  }

  const votesByAccount = new Map(doc.votes.map((vote) => [vote.account, vote]));
  for (const [account, event] of latest) {
    const vote = votesByAccount.get(account);
    if (vote === undefined) {
      diffs.push({
        field: `votes (${account})`,
        document: "absent",
        recomputed: `the event at state version ${event.stateVersion}`,
      });
      continue;
    }
    check(`votes (${account}).ciphertext`, vote.ciphertext ?? "absent", event.ciphertext);
    if (vote.timestamp !== null) {
      check(`votes (${account}).timestamp`, String(vote.timestamp), String(event.timestamp));
    }
    if (event.intentHash !== null) {
      check(`votes (${account}).intent_hash`, vote.intentHash ?? "absent", event.intentHash);
    }
  }
  for (const vote of doc.votes) {
    if (!latest.has(vote.account)) {
      diffs.push({
        field: `votes (${vote.account})`,
        document: "a published timely ballot",
        recomputed: "no timely SealedBallotCastEvent on the box's stream",
      });
    }
  }

  // Late ballots: every one the box emitted, and every one the document reports.
  const key = (account: string, ciphertext: string, timestamp: number): string =>
    `${account}\u0000${ciphertext}\u0000${timestamp}`;
  const lateEvents = new Map<string, SealedBallotEvent>();
  for (const event of forVote) {
    if (event.timestamp < roundTime) continue;
    lateEvents.set(key(event.account, event.ciphertext, event.timestamp), event);
  }
  const publishedLate = new Set(
    (doc.lateBallots ?? []).map((b) => key(b.account, b.ciphertext, b.timestamp)),
  );
  for (const [k, event] of lateEvents) {
    if (!publishedLate.has(k)) {
      diffs.push({
        field: `late_ballots (${event.account})`,
        document: "absent",
        recomputed: `the event at state version ${event.stateVersion}`,
      });
    }
  }
  for (const k of publishedLate) {
    if (!lateEvents.has(k)) {
      const [account, , timestamp] = k.split("\u0000");
      diffs.push({
        field: `late_ballots (${account})`,
        document: `a late ballot at ${timestamp}`,
        recomputed: "no such SealedBallotCastEvent on the box's stream",
      });
    }
  }
  return diffs;
}
