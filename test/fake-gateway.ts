/**
 * A GatewayClient backed by fixture files. Tests program it with canned responses in the
 * exact call order the weight recomputation makes them; an unexpected call fails loudly
 * rather than returning something plausible, so a test that drifts from the real call
 * sequence says so instead of passing on noise.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GatewayError } from "../src/gateway.ts";
import type { GatewayClient } from "../src/gateway.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8")) as unknown;
}

export class FakeGateway implements GatewayClient {
  private detailsQueue: unknown[] = [];
  private pageResponses = new Map<string, unknown>();
  private validatorsQueue: unknown[] = [];

  /** Fail the test on any call the fixture set did not anticipate. */
  calls: string[] = [];

  onDetails(response: unknown): this {
    this.detailsQueue.push(response);
    return this;
  }

  onFungiblesPage(cursor: string, response: unknown): this {
    this.pageResponses.set(cursor, response);
    return this;
  }

  onValidators(response: unknown): this {
    this.validatorsQueue.push(response);
    return this;
  }

  entityDetails(
    addresses: string[],
    _stateVersion: number,
    _opts: { global: boolean; explicitMetadata: string[] },
  ): Promise<unknown> {
    this.calls.push(`details:${addresses.join(",")}`);
    const next = this.detailsQueue.shift();
    if (next === undefined) {
      throw new GatewayError(`FakeGateway: unexpected entityDetails for ${addresses.join(",")}`);
    }
    return Promise.resolve(next);
  }

  entityFungiblesPage(address: string, cursor: string, _stateVersion: number): Promise<unknown> {
    this.calls.push(`page:${address}:${cursor}`);
    const resp = this.pageResponses.get(cursor);
    if (resp === undefined) {
      throw new GatewayError(`FakeGateway: unexpected fungibles page ${cursor}`);
    }
    return Promise.resolve(resp);
  }

  validatorsList(_stateVersion: number, _cursor: string | null): Promise<unknown> {
    this.calls.push("validators");
    const next = this.validatorsQueue.shift();
    if (next === undefined) throw new GatewayError("FakeGateway: unexpected validators list");
    return Promise.resolve(next);
  }
}

/** The fixture scenario wired in call order: two accounts (B paginated), one validator, the
 * held resources, the pool's declaration, the pool's balances. */
export function scenarioGateway(): FakeGateway {
  return new FakeGateway()
    .onDetails(fixture("accounts-details.json"))
    .onFungiblesPage("cursor-page-2", fixture("account-b-page2.json"))
    .onValidators(fixture("validators.json"))
    .onDetails(fixture("held-resources.json"))
    .onDetails(fixture("pool-units.json"))
    .onDetails(fixture("pool-balances.json"));
}

export const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
export const LSU = "resource_rdx1lsu000000000000000000000000000000000000000000000001";
export const POOL_UNIT = "resource_rdx1pu0000000000000000000000000000000000000000000000002";
export const DUST = "resource_rdx1dust000000000000000000000000000000000000000000000003";
export const IMPOSTOR = "resource_rdx1fake000000000000000000000000000000000000000000000004";
export const POOL = "pool_rdx1ppp0000000000000000000000000000000000000000000000005";
export const ACCOUNT_A = "account_rdx1aaa";
export const ACCOUNT_B = "account_rdx1bbb";
export const SNAPSHOT_SV = 1000000;
