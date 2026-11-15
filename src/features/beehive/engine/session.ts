import { EngineError, TOKEN_PATH, type Carrier } from "./transport";

/** Renew a token with at least this long left, so a call never starts on a dying token. */
const RENEW_MS = 60_000;

type TokenReply = { token: string; expires_at: number };

/** A Beehive session: trades the person's signed event for a token and keeps it fresh. */
export function createSession(
  carrier: Carrier,
  clock: () => number = Date.now,
) {
  let current: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  const fresh = () =>
    current !== null && current.expiresAt - clock() > RENEW_MS;

  async function mint(): Promise<string> {
    const authorization = await carrier.authorize();
    const reply = (await carrier.post(
      TOKEN_PATH,
      {},
      { authorization },
    )) as TokenReply;
    if (typeof reply.token !== "string" || typeof reply.expires_at !== "number")
      throw new EngineError("unknown", "Beehive sent an unreadable token", 0);
    current = { token: reply.token, expiresAt: reply.expires_at * 1000 };
    return reply.token;
  }

  function token(): Promise<string> {
    if (fresh() && current) return Promise.resolve(current.token);
    // One in-flight mint serves every concurrent caller.
    pending ??= mint().finally(() => {
      pending = null;
    });
    return pending;
  }

  return {
    /** POST to `path` with a bearer token. One `unauthenticated` reply earns one fresh token and one retry. */
    async call(
      path: string,
      body: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> {
      // A failed sign-in is not an expired token: only the engine call may earn a retry.
      const sent = await token();
      try {
        return await carrier.post(path, body, { bearer: sent }, signal);
      } catch (error) {
        if (!(error instanceof EngineError) || error.code !== "unauthenticated")
          throw error;
        // A sibling call may already have replaced the token the engine refused,
        // and that one is fine: only drop the one this call sent.
        if (current?.token === sent) current = null;
        return carrier.post(path, body, { bearer: await token() }, signal);
      }
    },
  };
}

export type Session = ReturnType<typeof createSession>;
