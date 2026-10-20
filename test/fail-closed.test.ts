/**
 * The fail-closed reads: a short Gateway answer is not a zero, an unhonoured metadata opt-in is
 * not an absent ticker, and a Membership weight comes from the collection amount rather than
 * from an id list an opt-in may have silently emptied.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isAllocatedAccount, isPreallocatedAccount } from "../src/address.ts";
import { computeAccountWeightBreakdown, fetchFungiblesAt, fetchResourceSymbolAt } from "../src/weights.ts";
import { GatewayError } from "../src/gateway.ts";
import { fetchNonFungibleAmountsAt } from "../src/concentrated.ts";
import { ACCOUNT_A, FakeGateway, SNAPSHOT_SV, XRD } from "./fake-gateway.ts";

const RESOURCE = "resource_rdx1t4golden";

/** The first two data values of a Radix address carry its entity-type byte; the checksum is
 * not consulted by the classifier, so a well-formed prefix is enough here. */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function accountOfType(type: number): string {
  const high = type >> 3;
  const low = (type & 0b111) << 2;
  return `account_rdx1${CHARSET[high]}${CHARSET[low]}qqqqqq`;
}
const PREALLOCATED = accountOfType(0x02);
const ALLOCATED = accountOfType(0xc1);

test("address classification: the entity-type byte separates preallocated from allocated", () => {
  assert.equal(isPreallocatedAccount(PREALLOCATED), true);
  assert.equal(isAllocatedAccount(PREALLOCATED), false);
  assert.equal(isAllocatedAccount(ALLOCATED), true);
  assert.equal(isPreallocatedAccount(ALLOCATED), false);
  assert.equal(isPreallocatedAccount("not an address"), false);
});

test("asset_symbol: a missing item is an error, never an empty ticker", async () => {
  const gw = new FakeGateway().onDetails({ items: [] });
  await assert.rejects(
    fetchResourceSymbolAt(gw, RESOURCE, SNAPSHOT_SV),
    (e: unknown) => e instanceof GatewayError && /no entity-details item/.test(e.message),
  );
});

test("asset_symbol: an answer without the explicit_metadata block is an error", async () => {
  const gw = new FakeGateway().onDetails({ items: [{ address: RESOURCE }] });
  await assert.rejects(
    fetchResourceSymbolAt(gw, RESOURCE, SNAPSHOT_SV),
    (e: unknown) => e instanceof GatewayError && /opt-in was not honoured/.test(e.message),
  );
});

test("asset_symbol: the item is matched by address, not taken as items[0]", async () => {
  const gw = new FakeGateway().onDetails({
    items: [
      {
        address: "resource_rdx1tsomeoneelse",
        explicit_metadata: { items: [{ key: "symbol", value: { typed: { value: "WRONG" } } }] },
      },
      {
        address: RESOURCE,
        explicit_metadata: { items: [{ key: "symbol", value: { typed: { value: "RIGHT" } } }] },
      },
    ],
  });
  assert.equal(await fetchResourceSymbolAt(gw, RESOURCE, SNAPSHOT_SV), "RIGHT");
});

test("asset_symbol: an item that declares no symbol is the empty string", async () => {
  const gw = new FakeGateway().onDetails({
    items: [{ address: RESOURCE, explicit_metadata: { items: [] } }],
  });
  assert.equal(await fetchResourceSymbolAt(gw, RESOURCE, SNAPSHOT_SV), "");
});

test("preallocated accounts must appear; an allocated account created after the snapshot reads 0", async () => {
  const missing = new FakeGateway().onDetails({ items: [] });
  await assert.rejects(
    fetchFungiblesAt(missing, [PREALLOCATED], SNAPSHOT_SV, "preallocated"),
    (e: unknown) => e instanceof GatewayError && /left out 1 that must exist/.test(e.message),
  );

  const allocated = new FakeGateway().onDetails({ items: [] });
  const balances = await fetchFungiblesAt(allocated, [ALLOCATED], SNAPSHOT_SV, "preallocated");
  assert.equal(balances.get(ALLOCATED), undefined, "an absent allocated account weighs zero");
});

test("a short fungible answer is not read as zero when every address must exist", async () => {
  const gw = new FakeGateway().onDetails({
    items: [{ address: ACCOUNT_A, fungible_resources: { items: [] } }],
  });
  await assert.rejects(
    fetchFungiblesAt(gw, [ACCOUNT_A, "resource_rdx1tmissing"], SNAPSHOT_SV, "all"),
    (e: unknown) => e instanceof GatewayError && /must exist at that state/.test(e.message),
  );
});

test("Membership: the collection amount decides, even when no local ids came back", async () => {
  const MEMBERSHIP = "resource_rdx1nmembership0000000000000000000000000000000000002";
  const gw = new FakeGateway()
    // The Vault-aggregated page an id walk would use reports the collection but no ids: the
    // opt-in was ignored. That must not be read as "not a member".
    .onNonFungibles(ACCOUNT_A, {
      items: [{ resource_address: MEMBERSHIP, vaults: { items: [{ vault_address: "internal_vault_rdx1a", items: [] }] } }],
    })
    .onNonFungibleAmounts(ACCOUNT_A, { items: [{ resource_address: MEMBERSHIP, amount: 3 }] });
  const breakdown = await computeAccountWeightBreakdown(
    gw,
    [ACCOUNT_A],
    SNAPSHOT_SV,
    { native_pools: { mode: "off" }, membership: { resource: MEMBERSHIP } },
    XRD,
  );
  assert.equal(breakdown.get(ACCOUNT_A)?.membership.toString(), "1");
  assert.deepEqual(gw.calls, [`nf-amounts:${ACCOUNT_A}`], "the id walk is not consulted");
});

test("Membership: a non-advancing cursor is an error, not a short count", async () => {
  const page = { items: [], next_cursor: "same" };
  const gw = new FakeGateway().onNonFungibleAmounts(ACCOUNT_A, page);
  await assert.rejects(
    fetchNonFungibleAmountsAt(gw, [ACCOUNT_A], new Set([RESOURCE]), SNAPSHOT_SV),
    (e: unknown) => e instanceof GatewayError && /non-advancing non-fungible amounts cursor/.test(e.message),
  );
});

test("Membership: an overflowed amount is an error, not a wrapped count", async () => {
  const gw = new FakeGateway().onNonFungibleAmounts(ACCOUNT_A, {
    items: [{ resource_address: RESOURCE, amount: Number.MAX_SAFE_INTEGER + 1 }],
  });
  await assert.rejects(
    fetchNonFungibleAmountsAt(gw, [ACCOUNT_A], new Set([RESOURCE]), SNAPSHOT_SV),
    (e: unknown) => e instanceof GatewayError && /not a non-negative integer/.test(e.message),
  );
});
