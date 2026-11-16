import { TOKEN_PATH } from "./transport";

/** An event the host asks the person's key to sign. */
export type EventTemplate = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

/** Signs a template with the person's key and returns the full event. */
export type WebSigner = (template: EventTemplate) => Promise<object>;

/**
 * The `Nostr <base64>` header for `POST {origin}` + `TOKEN_PATH`, signed by `sign`. The desktop
 * app signs in Rust and never calls this; it is for a build or harness that holds a signer.
 */
export async function signAuthorization(
  origin: string,
  sign: WebSigner,
  now: () => number = Date.now,
): Promise<string> {
  const event = await sign({
    kind: 27235,
    created_at: Math.floor(now() / 1000),
    tags: [
      ["u", `${origin}${TOKEN_PATH}`],
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
