/**
 * Library entry point.
 *
 * `verifyTallyDocument` re-derives a tally from Gateway state and answers in the same
 * classification the CLI exits with. `parseTallyDocument` is the parser the CLI calls to turn
 * a JSON answer into a document, so a caller that needs the document's own fields (for a
 * counter-claim, say) reads them exactly as the verifier did. `GatewayClient` is the slice of
 * the Gateway the recomputation reads; a caller with its own transport implements it.
 */

export { parseTallyDocument, DocumentError } from "./document.ts";
export type { TallyDocument } from "./document.ts";
export { GatewayError } from "./gateway.ts";
export type { GatewayClient } from "./gateway.ts";
export { verifyTallyDocument } from "./verify.ts";
export type { Difference, Outcome, VerifyOptions } from "./verify.ts";
