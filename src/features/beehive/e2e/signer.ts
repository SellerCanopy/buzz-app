import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { WebSigner } from "../engine/web-signer";

// Fixed keys for tests only. They sign nothing outside a scratch database.
const secret = Uint8Array.from(
  { length: 32 },
  (_, i) => (i * 7 + 3) & 0xff || 1,
);
const otherSecret = Uint8Array.from(
  { length: 32 },
  (_, i) => (i * 11 + 5) & 0xff || 1,
);

/** The test key's public key, hex. */
export const testPubkey = getPublicKey(secret);

/** A web signer backed by the fixed test key. */
export const testSigner: WebSigner = async (template) =>
  finalizeEvent(template, secret);

/** A second person's public key, hex, for specs that need someone to set a level for. */
export const otherPubkey = getPublicKey(otherSecret);

/** A web signer backed by the second person's key. */
export const otherSigner: WebSigner = async (template) =>
  finalizeEvent(template, otherSecret);
