/**
 * Minimal Radix Gateway client — only the three endpoints the weight rule reads, all pinned
 * to an explicit `state_version` so the recomputation looks at exactly the ledger state the
 * tally document pins, never at "now". A verifier that reads current state and compares it
 * against a historical document manufactures mismatches out of ordinary balance movement.
 *
 * Every failure this client can produce is a `GatewayError`, and `GatewayError` is the ONLY
 * thing verify.ts maps to the UNKNOWN verdict. That mapping is deliberate: a refused
 * connection or a pruned state version says nothing about the tally, and a verifier that
 * reports infrastructure trouble as a discrepancy trains people to ignore it.
 *
 * The User-Agent is curl-shaped because the Gateway's edge rejects the default Node/undici
 * agent with a bare HTTP 403 — learned empirically, not from any documentation. No header,
 * no answer.
 */

export class GatewayError extends Error {
  /** HTTP status when the gateway answered at all, so a 403 and a pruned-state 400 read differently in logs. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

/**
 * The slice of the Gateway the weight recomputation consumes. Tests inject a fixture-backed
 * implementation of this interface — the network never appears in a test.
 */
export interface GatewayClient {
  /** POST /state/entity/details, Global aggregation when balances are wanted. */
  entityDetails(
    addresses: string[],
    stateVersion: number,
    opts: { global: boolean; explicitMetadata: string[] },
  ): Promise<unknown>;
  /** POST /state/entity/page/fungibles — spends a `next_cursor` from the details endpoint. */
  entityFungiblesPage(address: string, cursor: string, stateVersion: number): Promise<unknown>;
  /** POST /state/validators/list, cursor-paginated. */
  validatorsList(stateVersion: number, cursor: string | null): Promise<unknown>;

  /**
   * POST /state/entity/details at a TIMESTAMP selector rather than a `state_version` — the
   * Gateway's timestamp -> state-version resolver. The only thing wanted back is the response
   * envelope's `ledger_state.state_version`; any well-known entity works as the address, since
   * the entity's own data is not read. This is the SAME call the reference engine's own
   * state-version lookup makes, ported here rather than approximated, for the mirror-tally
   * window bounds (`src/mirror.ts`) — the two Gateway
   * endpoints this tool otherwise reads (`entityDetails` above, and everything below) are always
   * pinned to an explicit `state_version` on purpose; this is the one deliberate exception,
   * because the window bounds are a TIMESTAMP by definition (`official_start` /
   * `official_deadline`) and there is no cheap inverse of this resolver.
   */
  entityDetailsAtTimestamp(address: string, timestampIso: string): Promise<unknown>;

  /* ---- the concentrated-liquidity legs (tally document v17) ----------------
   * Six more endpoints, because a position is a NON-FUNGIBLE and none of the three above can
   * see one. Every leg before v17 valued a balance, which the fungible endpoints report; a
   * concentrated-liquidity position's value is a formula over the pool's state fields and the
   * position's own NFT data, so the read path is per-account ids, per-position data, per-pool
   * vault resources, and a key-value-store walk of each shape pool's bin map.
   */

  /**
   * POST /state/entity/details at `aggregation_level: "Vault"`, which is the only shape that
   * reports a component's vault ADDRESSES. A pool's two token resources are learned from them:
   * the component's state names its vaults, and the engine says what each vault holds.
   */
  entityDetailsVault(addresses: string[], stateVersion: number): Promise<unknown>;
  /**
   * POST /state/entity/page/non-fungibles at Vault aggregation with
   * `non_fungible_include_nfids` — the only shape that hands back actual local ids; Global
   * aggregation reports counts only.
   */
  entityNonFungiblesPage(
    address: string,
    cursor: string | null,
    stateVersion: number,
  ): Promise<unknown>;
  /**
   * POST /state/entity/page/non-fungibles at `aggregation_level: "Global"` — the collection's
   * own `amount` per resource, with NO `non_fungible_include_nfids` opt-in.
   *
   * The Membership space's weight is "did this account hold at least one", and `amount` is
   * reported without any opt-in. The local-id walk behind `entityNonFungiblesPage` depends on
   * an opt-in the Gateway can silently ignore, which would make every member weigh zero with
   * no error anywhere; this call cannot fail that way.
   */
  entityNonFungiblesAmountsPage(
    address: string,
    cursor: string | null,
    stateVersion: number,
  ): Promise<unknown>;
  /** POST /state/entity/page/non-fungible-vaults — spends a per-RESOURCE vault cursor. */
  entityNonFungibleVaultsPage(
    address: string,
    resource: string,
    cursor: string,
    stateVersion: number,
  ): Promise<unknown>;
  /** POST /state/entity/page/non-fungible-vault/ids — spends a per-VAULT id cursor. */
  entityNonFungibleVaultIdsPage(
    address: string,
    resource: string,
    vaultAddress: string,
    cursor: string,
    stateVersion: number,
  ): Promise<unknown>;
  /**
   * POST /state/non-fungible/data. The historical read is mandatory rather than preferable: a
   * position closed between the snapshot and now reports `is_burned` with no `data` at the tip,
   * so a tip read silently zeroes every position that has since been withdrawn.
   */
  nonFungibleData(resource: string, ids: string[], stateVersion: number): Promise<unknown>;
  /** POST /state/key-value-store/keys — the bin map's keys, paged. */
  keyValueStoreKeys(
    kvsAddress: string,
    cursor: string | null,
    stateVersion: number,
  ): Promise<unknown>;
  /** POST /state/key-value-store/data — the values behind named bin-map keys. */
  keyValueStoreData(
    kvsAddress: string,
    keys: unknown[],
    stateVersion: number,
  ): Promise<unknown>;
}

/**
 * Refuse a Gateway answer that is not a state answer at the state the read asked for.
 *
 * Three kinds of answer are refused, matching the reference engine's rule:
 *
 *   1. An ERROR ENVELOPE (`{message, code, …}`), whatever HTTP status carried it. Read as data
 *      it has no `items`, and every walk over it would weigh the accounts it asked about at
 *      zero.
 *   2. An answer with no positive `ledger_state.state_version`. Every `/state/*` endpoint says
 *      which ledger state it answered at; a body without one cannot be placed at the state the
 *      walk asked for.
 *   3. An answer at ANOTHER state than the one asked for: a read pinned by `state_version` must
 *      answer at exactly that version; one pinned by `timestamp` must answer at or before the
 *      instant (its `proposer_round_timestamp` is checked); one pinned by `epoch` must answer in
 *      that epoch or before.
 *
 * What is NOT refused is a short or empty `items` list. Whether a missing item is legitimate
 * depends on what the address is, so each caller decides — see `fetchFungiblesAt`'s
 * preallocated-account rule.
 */
export function refuseGatewayAnswer(endpoint: string, payload: unknown, body: unknown): void {
  const o = asObject(body);
  const message = asString(o["message"]);
  if (message !== null) {
    const code = o["code"];
    throw new GatewayError(
      `gateway refused ${endpoint}: ${message}` +
        (typeof code === "number" || typeof code === "string" ? ` (code ${String(code)})` : ""),
    );
  }
  const ledger = asObject(o["ledger_state"]);
  const answered = ledger["state_version"];
  if (typeof answered !== "number" || !Number.isSafeInteger(answered) || answered <= 0) {
    throw new GatewayError(
      `gateway answered ${endpoint} with no ledger_state.state_version: a body that does not ` +
        `say which state it describes is not read as data`,
    );
  }
  const asked = asObject(asObject(payload)["at_ledger_state"]);
  const wantedVersion = asked["state_version"];
  if (typeof wantedVersion === "number") {
    if (answered !== wantedVersion) {
      throw new GatewayError(
        `gateway answered ${endpoint} at state version ${answered}, but the read asked for ` +
          `state version ${wantedVersion}: an answer at another state is not the state asked for`,
      );
    }
    return;
  }
  const wantedTimestamp = asked["timestamp"];
  if (typeof wantedTimestamp === "string") {
    const wantedMs = Date.parse(wantedTimestamp);
    if (!Number.isFinite(wantedMs)) {
      throw new GatewayError(`${endpoint}: the read's own timestamp ${wantedTimestamp} does not parse`);
    }
    const at = asString(ledger["proposer_round_timestamp"]);
    const answeredMs = at === null ? NaN : Date.parse(at);
    if (!Number.isFinite(answeredMs) || answeredMs > wantedMs) {
      throw new GatewayError(
        `gateway answered ${endpoint} at state version ${answered} (ledger time ` +
          `${JSON.stringify(at)}), but the read asked for the last state at or before ${wantedTimestamp}`,
      );
    }
    return;
  }
  const wantedEpoch = asked["epoch"];
  if (typeof wantedEpoch === "number") {
    const epoch = ledger["epoch"];
    if (typeof epoch !== "number" || epoch > wantedEpoch) {
      throw new GatewayError(
        `gateway answered ${endpoint} at state version ${answered} in epoch ` +
          `${JSON.stringify(epoch)}, but the read asked for the start of epoch ${wantedEpoch}`,
      );
    }
  }
}

export class RadixGateway implements GatewayClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Parameter properties would be terser, but they are not erasable syntax and this package
    // runs its tests through node's type stripping — no transform, no parameter properties.
    this.baseUrl = baseUrl;
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
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
        `gateway unreachable at ${this.baseUrl}${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      // A pruned historical state version comes back here as a 4xx. It is still UNKNOWN,
      // not a discrepancy — the classifier only sees the GatewayError.
      throw new GatewayError(
        `gateway answered HTTP ${res.status} for ${path}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new GatewayError(`gateway returned non-JSON for ${path}`, res.status);
    }
    refuseGatewayAnswer(path, payload, body);
    return body;
  }

  entityDetails(
    addresses: string[],
    stateVersion: number,
    opts: { global: boolean; explicitMetadata: string[] },
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      addresses,
      at_ledger_state: { state_version: stateVersion },
    };
    if (opts.global) payload["aggregation_level"] = "Global";
    if (opts.explicitMetadata.length > 0) {
      payload["opt_ins"] = { explicit_metadata: opts.explicitMetadata };
    }
    return this.post("/state/entity/details", payload);
  }

  entityFungiblesPage(address: string, cursor: string, stateVersion: number): Promise<unknown> {
    return this.post("/state/entity/page/fungibles", {
      address,
      cursor,
      aggregation_level: "Global",
      at_ledger_state: { state_version: stateVersion },
    });
  }

  validatorsList(stateVersion: number, cursor: string | null): Promise<unknown> {
    const payload: Record<string, unknown> = {
      at_ledger_state: { state_version: stateVersion },
    };
    if (cursor !== null) payload["cursor"] = cursor;
    return this.post("/state/validators/list", payload);
  }

  entityDetailsAtTimestamp(address: string, timestampIso: string): Promise<unknown> {
    return this.post("/state/entity/details", {
      addresses: [address],
      at_ledger_state: { timestamp: timestampIso },
    });
  }

  entityDetailsVault(addresses: string[], stateVersion: number): Promise<unknown> {
    return this.post("/state/entity/details", {
      addresses,
      aggregation_level: "Vault",
      at_ledger_state: { state_version: stateVersion },
    });
  }

  entityNonFungiblesPage(
    address: string,
    cursor: string | null,
    stateVersion: number,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      address,
      aggregation_level: "Vault",
      opt_ins: { non_fungible_include_nfids: true },
      at_ledger_state: { state_version: stateVersion },
    };
    if (cursor !== null) payload["cursor"] = cursor;
    return this.post("/state/entity/page/non-fungibles", payload);
  }

  entityNonFungiblesAmountsPage(
    address: string,
    cursor: string | null,
    stateVersion: number,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      address,
      aggregation_level: "Global",
      at_ledger_state: { state_version: stateVersion },
    };
    if (cursor !== null) payload["cursor"] = cursor;
    return this.post("/state/entity/page/non-fungibles", payload);
  }

  entityNonFungibleVaultsPage(
    address: string,
    resource: string,
    cursor: string,
    stateVersion: number,
  ): Promise<unknown> {
    return this.post("/state/entity/page/non-fungible-vaults", {
      address,
      resource_address: resource,
      cursor,
      opt_ins: { non_fungible_include_nfids: true },
      at_ledger_state: { state_version: stateVersion },
    });
  }

  entityNonFungibleVaultIdsPage(
    address: string,
    resource: string,
    vaultAddress: string,
    cursor: string,
    stateVersion: number,
  ): Promise<unknown> {
    return this.post("/state/entity/page/non-fungible-vault/ids", {
      address,
      resource_address: resource,
      vault_address: vaultAddress,
      cursor,
      at_ledger_state: { state_version: stateVersion },
    });
  }

  nonFungibleData(resource: string, ids: string[], stateVersion: number): Promise<unknown> {
    return this.post("/state/non-fungible/data", {
      resource_address: resource,
      non_fungible_ids: ids,
      at_ledger_state: { state_version: stateVersion },
    });
  }

  keyValueStoreKeys(
    kvsAddress: string,
    cursor: string | null,
    stateVersion: number,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      key_value_store_address: kvsAddress,
      at_ledger_state: { state_version: stateVersion },
    };
    if (cursor !== null) payload["cursor"] = cursor;
    return this.post("/state/key-value-store/keys", payload);
  }

  keyValueStoreData(kvsAddress: string, keys: unknown[], stateVersion: number): Promise<unknown> {
    return this.post("/state/key-value-store/data", {
      key_value_store_address: kvsAddress,
      keys,
      at_ledger_state: { state_version: stateVersion },
    });
  }
}

/* ---- response navigation --------------------------------------------------
 * Gateway responses are deep JSON with every level optional in practice. The reference
 * implementation tolerates absence with `unwrap_or` defaults; these helpers do the same,
 * because a missing field means "zero / not present" in this API, not "corrupt".
 */

export function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
