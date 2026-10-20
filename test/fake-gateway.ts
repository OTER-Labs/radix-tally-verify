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

/** An empty page — what the Gateway returns for an account that holds none of what was asked. */
const EMPTY_PAGE = { items: [] };

export class FakeGateway implements GatewayClient {
  private detailsQueue: unknown[] = [];
  private timestampDetailsQueue: unknown[] = [];
  private timestampDetailsAt = new Map<string, unknown>();
  private pageResponses = new Map<string, unknown>();
  private validatorsQueue: unknown[] = [];
  private vaultDetailsQueue: unknown[] = [];
  private nonFungiblesByAccount = new Map<string, unknown>();
  private nonFungibleAmountsByAccount = new Map<string, unknown>();
  private nonFungibleDataByResource = new Map<string, unknown>();
  private kvsKeys = new Map<string, unknown>();
  private kvsData = new Map<string, unknown>();
  private kvsDataVersioned = new Map<string, Array<{ stateVersion: number; response: unknown }>>();

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

  /** The mirror-tally window-bound resolver (`entityDetailsAtTimestamp`) — FIFO, like
   * `entityDetails`, since call order (start's timestamp before deadline's) is the contract. */
  onTimestampDetails(response: unknown): this {
    this.timestampDetailsQueue.push(response);
    return this;
  }

  /* ---- the v17 concentrated-liquidity reads --------------------------------
   * Programmed by ADDRESS rather than by queue position. The precision and shape legs
   * interleave their calls with each other and with the fungible legs, and a queue would make
   * every test depend on an ordering the implementation is free to change; keying on the
   * address asserts what was asked for instead.
   *
   * An unprogrammed non-fungible read returns an EMPTY page rather than failing, because "this
   * account holds none of these" is the answer for almost every account in almost every test —
   * making it explicit everywhere would bury the case each test is actually about. The
   * entityDetails queue keeps its fail-loudly behaviour, since those calls are the ones whose
   * order is the contract.
   */

  /** A timestamp-keyed answer for `entityDetailsAtTimestamp`, consulted before the FIFO queue:
   * for a test whose point is WHICH instant a bound is resolved from, so that asking for the
   * wrong one gets the wrong state version instead of whatever happens to be next in line. */
  onTimestampDetailsAt(unixSeconds: number, response: unknown): this {
    this.timestampDetailsAt.set(new Date(unixSeconds * 1000).toISOString(), response);
    return this;
  }

  onVaultDetails(response: unknown): this {
    this.vaultDetailsQueue.push(response);
    return this;
  }

  onNonFungibles(account: string, response: unknown): this {
    this.nonFungiblesByAccount.set(account, response);
    return this;
  }

  /** Global-aggregated collection amounts — the Membership weight's read. */
  onNonFungibleAmounts(account: string, response: unknown): this {
    this.nonFungibleAmountsByAccount.set(account, response);
    return this;
  }

  onNonFungibleData(resource: string, response: unknown): this {
    this.nonFungibleDataByResource.set(resource, response);
    return this;
  }

  onKvsKeys(kvsAddress: string, response: unknown): this {
    this.kvsKeys.set(kvsAddress, response);
    return this;
  }

  onKvsData(kvsAddress: string, response: unknown): this {
    this.kvsData.set(kvsAddress, response);
    return this;
  }

  entityDetailsVault(addresses: string[], _stateVersion: number): Promise<unknown> {
    this.calls.push(`vault-details:${addresses.join(",")}`);
    const next = this.vaultDetailsQueue.shift();
    if (next === undefined) {
      throw new GatewayError(
        `FakeGateway: unexpected entityDetailsVault for ${addresses.join(",")}`,
      );
    }
    return Promise.resolve(next);
  }

  entityNonFungiblesPage(
    address: string,
    _cursor: string | null,
    _stateVersion: number,
  ): Promise<unknown> {
    this.calls.push(`non-fungibles:${address}`);
    return Promise.resolve(this.nonFungiblesByAccount.get(address) ?? EMPTY_PAGE);
  }

  entityNonFungiblesAmountsPage(
    address: string,
    _cursor: string | null,
    _stateVersion: number,
  ): Promise<unknown> {
    this.calls.push(`nf-amounts:${address}`);
    return Promise.resolve(this.nonFungibleAmountsByAccount.get(address) ?? EMPTY_PAGE);
  }

  entityNonFungibleVaultsPage(
    address: string,
    resource: string,
    cursor: string,
    _stateVersion: number,
  ): Promise<unknown> {
    this.calls.push(`nf-vaults:${address}:${resource}:${cursor}`);
    return Promise.resolve(EMPTY_PAGE);
  }

  entityNonFungibleVaultIdsPage(
    _address: string,
    _resource: string,
    vaultAddress: string,
    cursor: string,
    _stateVersion: number,
  ): Promise<unknown> {
    this.calls.push(`nf-ids:${vaultAddress}:${cursor}`);
    return Promise.resolve(EMPTY_PAGE);
  }

  nonFungibleData(resource: string, ids: string[], _stateVersion: number): Promise<unknown> {
    this.calls.push(`nf-data:${resource}:${ids.join(",")}`);
    return Promise.resolve(
      this.nonFungibleDataByResource.get(resource) ?? { non_fungible_ids: [] },
    );
  }

  keyValueStoreKeys(
    kvsAddress: string,
    _cursor: string | null,
    _stateVersion: number,
  ): Promise<unknown> {
    this.calls.push(`kvs-keys:${kvsAddress}`);
    return Promise.resolve(this.kvsKeys.get(kvsAddress) ?? EMPTY_PAGE);
  }

  /** A key-value store's data as the ledger held it FROM `stateVersion` on: a read at state
   * version S is answered with the response programmed at the greatest version <= S, exactly as
   * the ledger answers a historical read with the last write at or before it. A read before every
   * programmed version gets no entry. Once any versioned answer is programmed for an address, the
   * unversioned `onKvsData` answer for it is never consulted, so a read at the wrong version gets
   * the wrong state instead of a plausible one. */
  onKvsDataAt(kvsAddress: string, stateVersion: number, response: unknown): this {
    const list = this.kvsDataVersioned.get(kvsAddress) ?? [];
    list.push({ stateVersion, response });
    list.sort((a, b) => a.stateVersion - b.stateVersion);
    this.kvsDataVersioned.set(kvsAddress, list);
    return this;
  }

  keyValueStoreData(
    kvsAddress: string,
    _keys: unknown[],
    stateVersion: number,
  ): Promise<unknown> {
    this.calls.push(`kvs-data:${kvsAddress}@${stateVersion}`);
    const versioned = this.kvsDataVersioned.get(kvsAddress);
    if (versioned !== undefined) {
      let answer: unknown = { entries: [] };
      for (const v of versioned) if (v.stateVersion <= stateVersion) answer = v.response;
      return Promise.resolve(answer);
    }
    return Promise.resolve(this.kvsData.get(kvsAddress) ?? { entries: [] });
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

  entityDetailsAtTimestamp(address: string, timestampIso: string): Promise<unknown> {
    this.calls.push(`timestamp-details:${address}:${timestampIso}`);
    const keyed = this.timestampDetailsAt.get(timestampIso);
    if (keyed !== undefined) return Promise.resolve(keyed);
    const next = this.timestampDetailsQueue.shift();
    if (next === undefined) {
      throw new GatewayError(`FakeGateway: unexpected entityDetailsAtTimestamp for ${timestampIso}`);
    }
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
