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
  /** A ready `Nostr <base64>` value, for `/auth/token` only. */
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
  /** The `Nostr <base64>` header value for `POST {origin}/auth/token`, signed by the person's key. */
  authorize(): Promise<string>;
}

/** Turn a response body into the parsed JSON, or a coded error for a non-JSON reply. */
export function decodeReply(
  status: number,
  statusText: string,
  text: string,
): unknown {
  let json: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    json =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : undefined;
  } catch {
    json = undefined;
  }
  const ok = status >= 200 && status < 300;
  if (ok && json) return json;
  if (json && !ok) {
    throw new EngineError(
      typeof json.code === "string" ? json.code : "unknown",
      typeof json.message === "string" ? json.message : statusText,
      status,
    );
  }
  // A proxy error page or an empty failure: the engine did not answer.
  throw new EngineError(
    "unavailable",
    statusText || "Beehive did not answer",
    status,
  );
}

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
      let res: Response;
      try {
        res = await fetch(`${origin}${path}`, {
          method: "POST",
          ...(signal ? { signal } : {}),
          headers: {
            "content-type": "application/json",
            "connect-protocol-version": "1",
            ...(authorization ? { authorization } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new EngineError("unavailable", "Beehive is not reachable", 0);
      }
      return decodeReply(res.status, res.statusText, await res.text());
    },
  };
}
