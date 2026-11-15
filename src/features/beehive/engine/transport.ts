/** The signed-in trade for a Beehive token. The signed event's `u` tag must name exactly this path. */
export const TOKEN_PATH = "/auth/token";

/** What a person reads when Beehive failed and said nothing more. */
export const NO_ANSWER = "Beehive did not answer";

/** The words to show for a failure: its own message, or `NO_ANSWER` when it has none. */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : NO_ANSWER;
}

/** A failure from Beehive or from reaching it. `code` follows the Connect error codes. */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export type PostOptions = {
  /** A Beehive token, sent as `Authorization: Bearer`. */
  bearer?: string;
  /** A ready `Nostr <base64>` value, for the token trade only. */
  authorization?: string;
};

export interface Carrier {
  /** POST JSON to `path` on the Beehive origin. Resolves the parsed body or throws `EngineError`. */
  post(
    path: string,
    body: unknown,
    opts: PostOptions,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** The `Nostr <base64>` header value for `POST {origin}` + `TOKEN_PATH`, signed by the person's key. */
  authorize(): Promise<string>;
}

/** Turn a response body into the parsed JSON, or a coded error for a non-JSON reply. */
export function decodeReply(
  status: number,
  statusText: string,
  text: string,
): unknown {
  const ok = status >= 200 && status < 300;
  let json: Record<string, unknown> | undefined;
  try {
    // An empty success is an empty message; an empty failure says nothing at all.
    const parsed: unknown = text ? JSON.parse(text) : ok ? {} : undefined;
    json =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
  } catch {
    json = undefined;
  }
  if (ok && json) return json;
  if (json && !ok) {
    const code = typeof json.code === "string" ? json.code : "unknown";
    const message = typeof json.message === "string" ? json.message : "";
    throw new EngineError(code, message || statusText || code, status);
  }
  // A proxy page or an empty failure: the engine did not answer. A 2xx status
  // text is just "OK", so a reply that is not JSON says what was wrong instead.
  throw new EngineError(
    "unavailable",
    ok
      ? `Beehive sent an unreadable reply (HTTP ${status})`
      : statusText || NO_ANSWER,
    status,
  );
}

/** A long poll waits up to 25 s on the engine, so it may take longer than any other call. */
const POLL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Reach Beehive with `fetch`. `authorize` supplies the signed NIP-98 header. */
export function webCarrier(
  origin: string,
  authorize: () => Promise<string>,
): Carrier {
  return {
    authorize,
    async post(path, body, opts, signal) {
      const authorization =
        opts.authorization ??
        (opts.bearer ? `Bearer ${opts.bearer}` : undefined);
      const timeout = AbortSignal.timeout(
        path.endsWith("/PollEvents") ? POLL_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      );
      let status = 0;
      let reply: { statusText: string; text: string };
      try {
        const res = await fetch(`${origin}${path}`, {
          method: "POST",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            "content-type": "application/json",
            "connect-protocol-version": "1",
            ...(authorization ? { authorization } : {}),
          },
          body: JSON.stringify(body),
        });
        status = res.status;
        reply = { statusText: res.statusText, text: await res.text() };
      } catch (error) {
        // The caller gave up: let it see its own abort. A timeout is Beehive not answering.
        if (signal?.aborted) throw error;
        throw new EngineError(
          "unavailable",
          timeout.aborted
            ? "Beehive did not answer in time"
            : status
              ? "Beehive stopped answering"
              : "Beehive is not reachable",
          status,
        );
      }
      return decodeReply(status, reply.statusText, reply.text);
    },
  };
}
