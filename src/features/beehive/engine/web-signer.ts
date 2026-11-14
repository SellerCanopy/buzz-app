import { EngineError } from "./transport";

/** An event the host asks the person's key to sign. */
export type EventTemplate = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

/** Signs a template with the person's key and returns the full event. */
export type WebSigner = (template: EventTemplate) => Promise<object>;

let signer: WebSigner | undefined;

/**
 * Give the web build a signer. The desktop app signs in Rust and never calls
 * this. Without a signer, the web build cannot sign in to Beehive.
 */
export function provideWebSigner(next: WebSigner | undefined) {
  signer = next;
}

/** The `Nostr <base64>` header for `POST {origin}/auth/token`, signed by the web signer. */
export async function webAuthorization(
  origin: string,
  now: () => number = Date.now,
): Promise<string> {
  if (!signer) {
    throw new EngineError(
      "unauthenticated",
      "Sign-in is not available here",
      0,
    );
  }
  const event = await signer({
    kind: 27235,
    created_at: Math.floor(now() / 1000),
    tags: [
      ["u", `${origin}/auth/token`],
      ["method", "POST"],
      ["nonce", crypto.randomUUID()],
    ],
    content: "",
  });
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary)}`;
}
