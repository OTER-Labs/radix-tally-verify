/**
 * Each post-v16 leg driven through the WHOLE tool — parse the register, read the Gateway,
 * recompute, re-derive, re-serialize, re-hash — against a small hand-built document.
 *
 * The unit tests beside this one check the formulas. These check the wiring, which is a
 * different failure: a rule can be arithmetically perfect and still be read from the wrong field,
 * fetched at the wrong state version, or compared against the wrong half of the document. Every
 * test here asserts a MATCH, then breaks exactly one figure and asserts the tool says so — a
 * verifier that cannot fail is not verifying.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tallyHash } from "../src/canonical.ts";
import type { Json } from "../src/canonical.ts";
import { verifyTallyDocument } from "../src/verify.ts";
import { FakeGateway, SNAPSHOT_SV, XRD } from "./fake-gateway.ts";

/** The documents here are built as plain records for readability; the canonicalizer wants the
 * Json union, and the cast is confined to this one helper rather than sprinkled at each call. */
const hash = (doc: Record<string, unknown>): string => tallyHash(doc as unknown as Json);

const ACC_A = "account_rdx1aaa";
const ACC_B = "account_rdx1bbb";
const OCI = "resource_rdx1t52pvtk5wfhltchwh3rkzls2x0r98fw9cjhpyrf3vsykhkuwrf7jg8";
const PRECISION_COMPONENT = "component_rdx1cp0precision0000000000000000000000000000000000000001";
const PRECISION_LP = "resource_rdx1n0precisionlp0000000000000000000000000000000000000002";
const SHAPE_COMPONENT = "component_rdx1cp0shape000000000000000000000000000000000000000000003";
const SHAPE_RECEIPT = "resource_rdx1n0shapereceipt00000000000000000000000000000000000004";
const DELEGATION_COMPONENT = "component_rdx1cp0delegation0000000000000000000000000000000000005";
const BIN_MAP = "internal_keyvaluestore_rdx1kv000000000000000000000000000000000000006";
const X_VAULT = "internal_vault_rdx1x0000000000000000000000000000000000000000000000005";
const Y_VAULT = "internal_vault_rdx1y0000000000000000000000000000000000000000000000006";

/** A Binding tally document with everything the verdict needs, over whatever the test varies. */
function bindingDoc(over: Record<string, unknown>): Record<string, unknown> {
  return {
    tally_doc_version: 20,
    consultation_id: "c-1",
    kind: "Binding",
    options: ["Reject", "Approve"],
    snapshot_state_version: SNAPSHOT_SV,
    excluded_accounts: [],
    quorum: "1",
    approval_threshold_pc: "50",
    min_affirmative_support: "0",
    min_unique_voters: 0,
    abstain_weight: "0",
    seats: 0,
    seat_rule: null,
    majority_judgment: null,
    winners: null,
    withdrawn_excluded: null,
    mas_met: true,
    quorum_met: true,
    approved: true,
    ...over,
  };
}

/** No fungibles at all — the concentrated legs are the only thing these accounts hold. */
const noFungibles = (accounts: string[]) => ({
  items: accounts.map((address) => ({ address, fungible_resources: { items: [] } })),
});
const xrdOnly = (entries: Array<[string, string]>) => ({
  items: entries.map(([address, amount]) => ({
    address,
    fungible_resources: { items: [{ resource_address: XRD, amount }] },
  })),
});
const noValidators = { validators: { items: [] } };
/** Supply and divisibility for the resources a named pool pairs. */
const tokenInfo = (resources: string[]) => ({
  items: resources.map((address) => ({
    address,
    details: { total_supply: "1000000", divisibility: 18 },
  })),
});
const backLink = (resource: string, key: string, component: string) => ({
  items: [
    {
      address: resource,
      explicit_metadata: { items: [{ key, value: { typed: { value: component } } }] },
    },
  ],
});

/* ---- the precision leg ---------------------------------------------------- */

const precisionComponentItem = {
  address: PRECISION_COMPONENT,
  details: {
    blueprint_name: "PrecisionPool",
    state: {
      fields: [
        { field_name: "lp_manager", value: PRECISION_LP },
        { field_name: "price_sqrt", value: "0.847502416631256480901344166758536566" },
        { field_name: "x_liquidity", value: X_VAULT },
        { field_name: "y_liquidity", value: Y_VAULT },
      ],
    },
  },
  fungible_resources: {
    items: [
      { resource_address: OCI, vaults: { items: [{ vault_address: X_VAULT, amount: "1" }] } },
      { resource_address: XRD, vaults: { items: [{ vault_address: Y_VAULT, amount: "1" }] } },
    ],
  },
};

/** The live-mainnet position from `concentrated.test.ts`, held by ACC_A as `#1#`. */
const MAINNET_POSITION_XRD = "254.929665520653811333";

function precisionGateway(): FakeGateway {
  return new FakeGateway()
    .onDetails(noFungibles([ACC_A])) // 1. the voter's fungibles: none
    .onValidators(noValidators) // 2. no validators, so no LSU leg
    .onVaultDetails({ items: [precisionComponentItem] }) // 3. the named pool, at Vault aggregation
    .onDetails(backLink(PRECISION_LP, "pool", PRECISION_COMPONENT)) // 4. its position resource names it back
    .onDetails(tokenInfo([OCI, XRD])) // 5. supply + divisibility of the pair it trades
    .onNonFungibles(ACC_A, {
      items: [
        {
          resource_address: PRECISION_LP,
          vaults: { items: [{ vault_address: "internal_vault_rdx1pos", items: ["#1#"] }] },
        },
      ],
    })
    .onNonFungibleData(PRECISION_LP, {
      non_fungible_ids: [
        {
          non_fungible_id: "#1#",
          data: {
            programmatic_json: {
              fields: [
                {
                  field_name: "liquidity",
                  value: "2016.738774772895807708564745848344742595",
                },
                { field_name: "left_bound", value: "-6540" },
                { field_name: "right_bound", value: "7260" },
              ],
            },
          },
        },
      ],
    });
}

function precisionDoc(weight: string): Record<string, unknown> {
  return bindingDoc({
    weight_sources: {
      native_pools: { mode: "off" },
      precision_pools: { mode: "allowlist", pools: [PRECISION_COMPONENT] },
    },
    votes: [{ account: ACC_A, selection: [1], weight }],
    totals: ["0", weight],
    total_weight: weight,
    voter_count: 1,
    approve_weight: weight,
    reject_weight: "0",
  });
}

test("a precision-pool position carries the whole weight of a v17 document", async () => {
  const doc = precisionDoc(MAINNET_POSITION_XRD);
  const outcome = await verifyTallyDocument(doc, hash(doc), precisionGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("a precision-pool weight that is off by one place is a FIGURE difference", async () => {
  // The last of the eighteen places, and nothing else. This is the whole reason the tick power
  // is evaluated at 36 places and truncated rather than rounded.
  const doc = precisionDoc("254.929665520653811334");
  const outcome = await verifyTallyDocument(doc, hash(doc), precisionGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const fields = outcome.differences.map((x) => x.field);
  assert.ok(
    fields.some((f) => f.startsWith("votes[0].weight")),
    `the recomputed weight should differ: ${fields.join(", ")}`,
  );
});

test("a register naming a component that is not a PrecisionPool is refused, not valued", async () => {
  // The ledger reports the blueprint, and a component cannot lie about which package's code it
  // runs. A document whose own register names something else has a weight rule that cannot be
  // applied to the ledger it pins — there is no figure to disagree about.
  const gw = new FakeGateway()
    .onDetails(noFungibles([ACC_A]))
    .onValidators(noValidators)
    .onVaultDetails({
      items: [
        {
          ...precisionComponentItem,
          details: { ...precisionComponentItem.details, blueprint_name: "SomethingElse" },
        },
      ],
    })
    // The back-link read happens BEFORE the blueprint check refuses the component — the manager
    // field is read off whatever the component claims — so the fixture has to answer it.
    .onDetails(backLink(PRECISION_LP, "pool", PRECISION_COMPONENT));
  const doc = precisionDoc(MAINNET_POSITION_XRD);
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD);
  assert.equal(outcome.kind, "malformed");
  if (outcome.kind !== "malformed") return;
  assert.match(outcome.reason, /blueprint/);
});

test("a named pool the gateway did not return at the snapshot contributes zero", async () => {
  // Expected for any register that outlives a pool's deployment: the component did not exist at
  // that state version. Dropped rather than failing the verification, so the rest of the tally
  // still verifies — as a quorate-or-not tally of zero weight, which is the honest answer.
  const gw = new FakeGateway()
    .onDetails(noFungibles([ACC_A]))
    .onValidators(noValidators)
    .onVaultDetails({ items: [] });
  const doc = {
    ...precisionDoc("0"),
    quorum_met: false,
    approved: false,
    approve_weight: "0",
    reject_weight: "0",
  };
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

/* ---- the shape leg -------------------------------------------------------- */

const shapeComponentItem = {
  address: SHAPE_COMPONENT,
  details: {
    blueprint_name: "QuantaSwap",
    state: {
      fields: [
        { field_name: "liquidity_receipt_manager", value: SHAPE_RECEIPT },
        { field_name: "tokens_x", value: X_VAULT },
        { field_name: "tokens_y", value: Y_VAULT },
        { field_name: "bin_map", value: BIN_MAP },
        { field_name: "active_x", value: "400" },
        { field_name: "active_y", value: "800" },
        { field_name: "active_total_claim", value: "1000" },
        {
          field_name: "tick_index",
          fields: [
            {
              field_name: "current",
              variant_name: "Some",
              fields: [{ fields: [{ value: "100" }] }],
            },
          ],
        },
      ],
    },
  },
  fungible_resources: {
    items: [
      { resource_address: OCI, vaults: { items: [{ vault_address: X_VAULT, amount: "1" }] } },
      { resource_address: XRD, vaults: { items: [{ vault_address: Y_VAULT, amount: "1" }] } },
    ],
  },
};

const binEntry = (tick: string, amount: string, totalClaim: string) => ({
  key: { programmatic_json: { fields: [{ value: tick }] } },
  value: {
    programmatic_json: {
      fields: [
        { field_name: "amount", value: amount },
        { field_name: "total_claim", value: totalClaim },
      ],
    },
  },
});

function shapeGateway(): FakeGateway {
  return new FakeGateway()
    .onDetails(noFungibles([ACC_A]))
    .onValidators(noValidators)
    .onVaultDetails({ items: [shapeComponentItem] })
    .onDetails(backLink(SHAPE_RECEIPT, "component", SHAPE_COMPONENT))
    .onKvsKeys(BIN_MAP, {
      items: [
        { key: { programmatic_json: { fields: [{ value: "99" }] } } },
        { key: { programmatic_json: { fields: [{ value: "101" }] } } },
      ],
    })
    .onKvsData(BIN_MAP, {
      entries: [binEntry("99", "500", "1000"), binEntry("101", "700", "1000")],
    })
    .onDetails(tokenInfo([OCI, XRD]))
    .onNonFungibles(ACC_A, {
      items: [
        {
          resource_address: SHAPE_RECEIPT,
          vaults: { items: [{ vault_address: "internal_vault_rdx1rec", items: ["#7#"] }] },
        },
      ],
    })
    .onNonFungibleData(SHAPE_RECEIPT, {
      non_fungible_ids: [
        {
          non_fungible_id: "#7#",
          data: {
            programmatic_json: {
              fields: [
                {
                  field_name: "liquidity_claims",
                  entries: [
                    { key: { value: "99" }, value: { value: "250" } },
                    { key: { value: "100" }, value: { value: "250" } },
                    { key: { value: "101" }, value: { value: "250" } },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
}

test("a shape-pool receipt resolves its bins through the whole pipeline", async () => {
  // 125 XRD from the below-tick bin (250/1000 of 500), 200 from the active tick's y reserve
  // (250/1000 of 800), and nothing from the above-tick bin, which redeems in the unrecognised
  // token_x. 325 in total — the figure `concentrated.test.ts` pins on the pure function.
  const doc = bindingDoc({
    weight_sources: {
      native_pools: { mode: "off" },
      shape_pools: { mode: "allowlist", pools: [SHAPE_COMPONENT] },
    },
    votes: [{ account: ACC_A, selection: [1], weight: "325" }],
    totals: ["0", "325"],
    total_weight: "325",
    voter_count: 1,
    approve_weight: "325",
    reject_weight: "0",
  });
  const outcome = await verifyTallyDocument(doc, hash(doc), shapeGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

/* ---- the delegation leg --------------------------------------------------- */

/** Plain XRD holders — the delegation leg is about whose ballot carries the weight, not how
 * much any balance is worth, so the weight legs are kept trivial here on purpose. */
function delegationGateway(): FakeGateway {
  return new FakeGateway()
    .onDetails(
      xrdOnly([
        [ACC_A, "40"],
        [ACC_B, "60"],
      ]),
    )
    .onValidators(noValidators);
}

test("a delegation document recomputes its resolution, its split and its totals", async () => {
  // A delegated to B and did not vote; B voted Approve. B's ballot carries 60 own + 40
  // delegated, and B is still ONE voter.
  const doc = bindingDoc({
    weight_sources: {
      native_pools: { mode: "off" },
      delegation: { mode: "component", component: DELEGATION_COMPONENT },
    },
    weight_set_version: 3,
    excluded_set_version: 1,
    delegation_input: [{ delegator: ACC_A, delegate: ACC_B, delegate_declined: false }],
    delegations: [
      { delegator: ACC_A, delegate: ACC_B, weight: "40", counted: true, reason: null },
    ],
    delegated_weight_total: "40",
    votes: [
      { account: ACC_B, selection: [1], weight: "60", delegated_weight: "40", effective_weight: "100" },
    ],
    totals: ["0", "100"],
    total_weight: "100",
    voter_count: 1,
    approve_weight: "100",
    reject_weight: "0",
  });
  const outcome = await verifyTallyDocument(doc, hash(doc), delegationGateway(), XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});

test("a delegation the document calls counted, but which was revoked, is a FIGURE difference", async () => {
  // The delegator DID vote here, which revokes the standing instruction — so a document still
  // reporting the delegation as counted has published a resolution the inputs do not support.
  // The delegator's own ballot is present, which is exactly how the tool can tell.
  const doc = bindingDoc({
    weight_sources: {
      native_pools: { mode: "off" },
      delegation: { mode: "component", component: DELEGATION_COMPONENT },
    },
    delegation_input: [{ delegator: ACC_A, delegate: ACC_B, delegate_declined: false }],
    delegations: [
      { delegator: ACC_A, delegate: ACC_B, weight: "40", counted: true, reason: null },
    ],
    delegated_weight_total: "40",
    votes: [
      { account: ACC_A, selection: [0], weight: "40", delegated_weight: "0", effective_weight: "40" },
      { account: ACC_B, selection: [1], weight: "60", delegated_weight: "40", effective_weight: "100" },
    ],
    totals: ["40", "100"],
    total_weight: "140",
    voter_count: 2,
    approve_weight: "100",
    reject_weight: "40",
  });
  const outcome = await verifyTallyDocument(doc, hash(doc), delegationGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const fields = outcome.differences.map((x) => x.field);
  assert.ok(fields.includes("delegations[0].counted"), fields.join(", "));
  assert.ok(fields.includes("delegations[0].reason"), fields.join(", "));
  assert.ok(fields.includes("delegated_weight_total"), fields.join(", "));
});

test("a delegator who never voted still has their weight recomputed from the Gateway", async () => {
  // The delegator's weight appears in `delegations[].weight` and inside the delegate's effective
  // weight, so it has to be fetched even though the account cast no ballot. A verifier that
  // computed weights only for the accounts in `votes` would recompute it as zero and report an
  // honest document as a lie.
  const doc = bindingDoc({
    weight_sources: {
      native_pools: { mode: "off" },
      delegation: { mode: "component", component: DELEGATION_COMPONENT },
    },
    delegation_input: [{ delegator: ACC_A, delegate: ACC_B, delegate_declined: false }],
    // The document UNDERSTATES the delegator's weight; the Gateway says 40.
    delegations: [
      { delegator: ACC_A, delegate: ACC_B, weight: "1", counted: true, reason: null },
    ],
    delegated_weight_total: "1",
    votes: [
      { account: ACC_B, selection: [1], weight: "60", delegated_weight: "1", effective_weight: "61" },
    ],
    totals: ["0", "61"],
    total_weight: "61",
    voter_count: 1,
    approve_weight: "61",
    reject_weight: "0",
  });
  const outcome = await verifyTallyDocument(doc, hash(doc), delegationGateway(), XRD);
  assert.equal(outcome.kind, "figures");
  if (outcome.kind !== "figures") return;
  const fields = outcome.differences.map((x) => x.field);
  assert.ok(fields.includes("delegations[0].weight"), fields.join(", "));
  assert.ok(fields.includes("total_weight"), fields.join(", "));
});

/* ---- the v19 register versions and the v20 verdict ------------------------ */

test("the v19 set versions are carried through the hash without being invented", async () => {
  // They are not recomputable from Gateway state — their job is to let someone fetch the two
  // sets by version from the registry and check the lists this document EMBEDS. So they are
  // carried, hashed, and never derived.
  const doc = bindingDoc({
    weight_sources: { native_pools: { mode: "off" } },
    weight_set_version: 7,
    excluded_set_version: 2,
    votes: [{ account: ACC_A, selection: [1], weight: "40" }],
    totals: ["0", "40"],
    total_weight: "40",
    voter_count: 1,
    approve_weight: "40",
    reject_weight: "0",
  });
  const gw = new FakeGateway().onDetails(xrdOnly([[ACC_A, "40"]])).onValidators(noValidators);
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });

  // Changing one moves the hash, which is what makes them checkable at all.
  const moved = { ...doc, weight_set_version: 8 };
  assert.notEqual(hash(moved), hash(doc));
});

test("a tally sitting exactly on its bar is approved end to end (v20)", async () => {
  // 50 approve, 50 reject, a 50 bar. Under the strict comparison this consultation failed; under
  // the framework's own at-or-above wording it passes.
  const doc = bindingDoc({
    weight_sources: { native_pools: { mode: "off" } },
    votes: [
      { account: ACC_A, selection: [0], weight: "50" },
      { account: ACC_B, selection: [1], weight: "50" },
    ],
    totals: ["50", "50"],
    total_weight: "100",
    voter_count: 2,
    approve_weight: "50",
    reject_weight: "50",
    approved: true,
  });
  const gw = new FakeGateway()
    .onDetails(
      xrdOnly([
        [ACC_A, "50"],
        [ACC_B, "50"],
      ]),
    )
    .onValidators(noValidators);
  const outcome = await verifyTallyDocument(doc, hash(doc), gw, XRD);
  assert.deepEqual(outcome, { kind: "match", hashChecked: true });
});
