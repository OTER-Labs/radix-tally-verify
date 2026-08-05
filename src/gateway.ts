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
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GatewayError(`gateway returned non-JSON for ${path}`, res.status);
    }
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
