/**
 * The Gateway answer gate: an answer that does not say which ledger state it describes, or
 * that describes a different state than the read asked for, is refused before any caller reads
 * `items`. A short answer is left to the call site; an answer at the wrong state is not.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GatewayError, refuseGatewayAnswer } from "../src/gateway.ts";

const ENDPOINT = "/state/entity/details";
const refused = (e: unknown): boolean => e instanceof GatewayError;

test("an answer at the requested state version is accepted", () => {
  refuseGatewayAnswer(ENDPOINT, { at_ledger_state: { state_version: 42 } }, {
    ledger_state: { state_version: 42 },
    items: [],
  });
});

test("an answer at another state version is refused", () => {
  assert.throws(
    () =>
      refuseGatewayAnswer(ENDPOINT, { at_ledger_state: { state_version: 42 } }, {
        ledger_state: { state_version: 43 },
        items: [],
      }),
    (e: unknown) => refused(e) && /asked for state version 42/.test((e as Error).message),
  );
});

test("an answer with no ledger_state.state_version is refused", () => {
  assert.throws(
    () => refuseGatewayAnswer(ENDPOINT, { at_ledger_state: { state_version: 42 } }, { items: [] }),
    (e: unknown) => refused(e) && /no ledger_state.state_version/.test((e as Error).message),
  );
});

test("an error envelope is refused even when it carries a ledger state", () => {
  assert.throws(
    () =>
      refuseGatewayAnswer(ENDPOINT, { at_ledger_state: { state_version: 42 } }, {
        message: "state version 42 is not available",
        code: 400,
        ledger_state: { state_version: 42 },
      }),
    (e: unknown) => refused(e) && /gateway refused/.test((e as Error).message),
  );
});

test("a timestamp pin is held to at-or-before the instant", () => {
  const payload = { at_ledger_state: { timestamp: "2026-08-29T12:00:00.000Z" } };
  refuseGatewayAnswer(ENDPOINT, payload, {
    ledger_state: { state_version: 7, proposer_round_timestamp: "2026-08-29T11:59:59.000Z" },
  });
  assert.throws(
    () =>
      refuseGatewayAnswer(ENDPOINT, payload, {
        ledger_state: { state_version: 7, proposer_round_timestamp: "2026-08-29T12:00:01.000Z" },
      }),
    (e: unknown) => refused(e) && /last state at or before/.test((e as Error).message),
  );
});

test("a timestamp pin whose answer carries no ledger time is refused", () => {
  assert.throws(
    () =>
      refuseGatewayAnswer(
        ENDPOINT,
        { at_ledger_state: { timestamp: "2026-08-29T12:00:00.000Z" } },
        { ledger_state: { state_version: 7 } },
      ),
    (e: unknown) => refused(e) && /last state at or before/.test((e as Error).message),
  );
});

test("an epoch pin must answer in that epoch or before", () => {
  refuseGatewayAnswer(ENDPOINT, { at_ledger_state: { epoch: 10 } }, {
    ledger_state: { state_version: 7, epoch: 10 },
  });
  assert.throws(
    () =>
      refuseGatewayAnswer(ENDPOINT, { at_ledger_state: { epoch: 10 } }, {
        ledger_state: { state_version: 7, epoch: 11 },
      }),
    (e: unknown) => refused(e) && /start of epoch 10/.test((e as Error).message),
  );
});
