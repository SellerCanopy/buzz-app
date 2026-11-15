import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { WebSigner } from "../engine/web-signer";

// A fixed key for tests only. It signs nothing outside a scratch database.
const secret = Uint8Array.from(
  { length: 32 },
  (_, i) => (i * 7 + 3) & 0xff || 1,
);

/** The test key's public key, hex. */
export const testPubkey = getPublicKey(secret);

/** A web signer backed by the fixed test key. */
export const testSigner: WebSigner = async (template) =>
  finalizeEvent(template, secret);
