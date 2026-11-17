import { describe, expect, it, vi } from "vitest";
import { createSession } from "./session";
import { EngineError, type Carrier } from "./transport";

/** `reject(path)` may return an error to throw for a call to `path`. */
function carrier(
  reject: (path: string) => EngineError | undefined = () => undefined,
) {
  let n = 0;
  const post = vi.fn(async (path: string) => {
    const error = reject(path);
    if (error) throw error;
    if (path === "/auth/token") {
      n += 1;
      return { token: `t${n}`, expires_at: 1_000 + 900 };
    }
    return { ok: true };
  });
  const authorize = vi.fn(async () => "Nostr abc");
  return { post, authorize } as Carrier & {
    post: typeof post;
    authorize: typeof authorize;
  };
}

describe("session", () => {
  it("trades the signed event for a token and sends it as the bearer", async () => {
    const c = carrier();
    await createSession(c, () => 1_000_000).call("/x", {});
    expect(c.post).toHaveBeenNthCalledWith(
      1,
      "/auth/token",
      {},
      { authorization: "Nostr abc" },
    );
    expect(c.post).toHaveBeenNthCalledWith(
      2,
      "/x",
      {},
      { bearer: "t1" },
      undefined,
    );
  });

  it("mints once for concurrent calls", async () => {
    const c = carrier();
    const session = createSession(c, () => 1_000_000);
    await Promise.all([session.call("/a", {}), session.call("/b", {})]);
    expect(c.authorize).toHaveBeenCalledTimes(1);
  });

  it("reuses a token that has more than a minute left", async () => {
    const c = carrier();
    let now = 1_000_000;
    const session = createSession(c, () => now);
    await session.call("/a", {});
    now = 1_000_000 + 839_000; // 61 s left
    await session.call("/a", {});
    expect(c.authorize).toHaveBeenCalledTimes(1);
  });

  it("renews a token with less than a minute left", async () => {
    const c = carrier();
    let now = 1_000_000;
    const session = createSession(c, () => now);
    await session.call("/a", {});
    now = 1_000_000 + 841_000; // 59 s left
    await session.call("/a", {});
    expect(c.authorize).toHaveBeenCalledTimes(2);
    expect(c.post).toHaveBeenLastCalledWith(
      "/a",
      {},
      { bearer: "t2" },
      undefined,
    );
  });

  it("retries once with a fresh token on unauthenticated", async () => {
    let calls = 0;
    const c = carrier((path) =>
      path === "/a" && calls++ === 0
        ? new EngineError("unauthenticated", "expired", 401)
        : undefined,
    );
    await expect(
      createSession(c, () => 1_000_000).call("/a", {}),
    ).resolves.toEqual({ ok: true });
    expect(c.authorize).toHaveBeenCalledTimes(2);
  });

  it("surfaces a second unauthenticated reply", async () => {
    const c = carrier((path) =>
      path === "/a" ? new EngineError("unauthenticated", "no", 401) : undefined,
    );
    await expect(
      createSession(c, () => 1_000_000).call("/a", {}),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(c.authorize).toHaveBeenCalledTimes(2);
  });

  it("does not retry other failures", async () => {
    const c = carrier((path) =>
      path === "/a"
        ? new EngineError("permission_denied", "no", 403)
        : undefined,
    );
    await expect(
      createSession(c, () => 1_000_000).call("/a", {}),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(c.authorize).toHaveBeenCalledTimes(1);
  });

  it("starts a new mint after a failed one", async () => {
    const c = carrier();
    c.authorize.mockRejectedValueOnce(new EngineError("unavailable", "x", 0));
    const session = createSession(c, () => 1_000_000);
    await expect(session.call("/a", {})).rejects.toBeInstanceOf(EngineError);
    await expect(session.call("/a", {})).resolves.toEqual({ ok: true });
  });
  it("rejects a token reply without a token, with code unknown, and does not keep it", async () => {
    const c = carrier();
    c.post.mockResolvedValueOnce({} as never);
    const session = createSession(c, () => 1_000_000);
    await expect(session.call("/a", {})).rejects.toMatchObject({
      code: "unknown",
    });
    // Nothing was cached from it: the next call trades again and succeeds.
    await expect(session.call("/a", {})).resolves.toEqual({ ok: true });
    expect(c.authorize).toHaveBeenCalledTimes(2);
  });

  it("passes the caller's signal to the engine call, on the retry too", async () => {
    let calls = 0;
    const c = carrier((path) =>
      path === "/a" && calls++ === 0
        ? new EngineError("unauthenticated", "expired", 401)
        : undefined,
    );
    const { signal } = new AbortController();
    await createSession(c, () => 1_000_000).call("/a", { x: 1 }, signal);
    const engineCalls = c.post.mock.calls.filter(([path]) => path === "/a");
    expect(engineCalls).toHaveLength(2);
    for (const call of engineCalls) expect((call as unknown[])[3]).toBe(signal);
  });

  it("does not retry a failed sign-in as if the token had expired", async () => {
    const c = carrier();
    c.authorize.mockRejectedValue(
      new EngineError("unauthenticated", "no", 401),
    );
    await expect(
      createSession(c, () => 1_000_000).call("/a", {}),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(c.authorize).toHaveBeenCalledTimes(1);
    expect(c.post).not.toHaveBeenCalled();
  });

  it("does not drop a newer token when an older call is refused late", async () => {
    // Two calls go out on t1. Both are refused. The first to hear earns t2;
    // the second must use that t2 rather than throw it away and mint t3.
    const refused: (() => void)[] = [];
    let n = 0;
    const post = vi.fn(
      async (
        path: string,
        _body: unknown,
        opts: { bearer?: string },
      ): Promise<unknown> => {
        if (path === "/auth/token") {
          n += 1;
          return { token: `t${n}`, expires_at: 1_000 + 900 };
        }
        if (opts.bearer === "t1")
          return new Promise((_resolve, reject) =>
            refused.push(() =>
              reject(new EngineError("unauthenticated", "expired", 401)),
            ),
          );
        return { ok: true, with: opts.bearer };
      },
    );
    const authorize = vi.fn(async () => "Nostr abc");
    const session = createSession(
      { post, authorize } as unknown as Carrier,
      () => 1_000_000,
    );
    const a = session.call("/a", {});
    const b = session.call("/b", {});
    await vi.waitFor(() => expect(refused).toHaveLength(2));
    refused[0]?.();
    await expect(a).resolves.toEqual({ ok: true, with: "t2" });
    refused[1]?.();
    await expect(b).resolves.toEqual({ ok: true, with: "t2" });
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("mints once more, not twice, when two calls are refused together", async () => {
    let calls = 0;
    const c = carrier((path) =>
      path === "/a" && calls++ < 2
        ? new EngineError("unauthenticated", "expired", 401)
        : undefined,
    );
    const session = createSession(c, () => 1_000_000);
    await Promise.all([session.call("/a", {}), session.call("/a", {})]);
    // One mint for the first token, one for both retries.
    expect(c.authorize).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the new token cannot be minted", async () => {
    let calls = 0;
    const c = carrier((path) =>
      path === "/a" && calls++ === 0
        ? new EngineError("unauthenticated", "expired", 401)
        : undefined,
    );
    c.authorize
      .mockResolvedValueOnce("Nostr abc")
      .mockRejectedValueOnce(new EngineError("unavailable", "down", 0));
    await expect(
      createSession(c, () => 1_000_000).call("/a", {}),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(c.post.mock.calls.filter(([path]) => path === "/a")).toHaveLength(1);
  });

  describe("with a native token source", () => {
    it("uses the native token as the bearer and never signs or trades", async () => {
      const c = carrier();
      const native = { token: vi.fn(async () => "native1") };
      await createSession(c, () => 1_000_000, native).call("/x", {});
      expect(c.authorize).not.toHaveBeenCalled();
      expect(c.post).toHaveBeenCalledTimes(1);
      expect(c.post).toHaveBeenCalledWith(
        "/x",
        {},
        { bearer: "native1" },
        undefined,
      );
    });

    it("asks the native side again for each call, so it can renew", async () => {
      const c = carrier();
      let n = 0;
      const native = { token: vi.fn(async () => `n${++n}`) };
      const session = createSession(c, () => 1_000_000, native);
      await session.call("/a", {});
      await session.call("/a", {});
      expect(c.post).toHaveBeenLastCalledWith(
        "/a",
        {},
        { bearer: "n2" },
        undefined,
      );
      expect(c.authorize).not.toHaveBeenCalled();
    });

    it("retries once on unauthenticated and asks native to refresh, not resend", async () => {
      let calls = 0;
      const c = carrier((path) =>
        path === "/a" && calls++ === 0
          ? new EngineError("unauthenticated", "expired", 401)
          : undefined,
      );
      // Native resends its cached token unless it is told to refresh.
      const native = {
        token: vi.fn(async (options?: { refresh?: boolean }) =>
          options?.refresh ? "fresh" : "cached",
        ),
      };
      await expect(
        createSession(c, () => 1_000_000, native).call("/a", {}),
      ).resolves.toEqual({ ok: true });
      expect(native.token).toHaveBeenNthCalledWith(1, undefined);
      expect(native.token).toHaveBeenNthCalledWith(2, { refresh: true });
      expect(c.post).toHaveBeenNthCalledWith(
        1,
        "/a",
        {},
        { bearer: "cached" },
        undefined,
      );
      expect(c.post).toHaveBeenNthCalledWith(
        2,
        "/a",
        {},
        { bearer: "fresh" },
        undefined,
      );
      expect(c.authorize).not.toHaveBeenCalled();
    });

    it("surfaces a second unauthenticated reply after the one retry", async () => {
      const c = carrier((path) =>
        path === "/a"
          ? new EngineError("unauthenticated", "expired", 401)
          : undefined,
      );
      const native = { token: vi.fn(async () => "n") };
      await expect(
        createSession(c, () => 1_000_000, native).call("/a", {}),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      expect(native.token).toHaveBeenCalledTimes(2);
      expect(c.post).toHaveBeenCalledTimes(2);
    });

    it("gives the fallback message for a rejection that is not an Error", async () => {
      const c = carrier();
      const native = { token: vi.fn(() => Promise.reject("nope")) };
      await expect(
        createSession(c, () => 1_000_000, native).call("/a", {}),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "Native sign-in failed",
      });
      expect(c.post).not.toHaveBeenCalled();
    });

    it.each([
      ["empty", ""],
      ["not a string", 42],
      ["missing", undefined],
    ])("rejects a native token that is %s as unavailable", async (_, value) => {
      const c = carrier();
      const native = { token: vi.fn(async () => value as never) };
      await expect(
        createSession(c, () => 1_000_000, native).call("/a", {}),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(c.post).not.toHaveBeenCalled();
    });

    it("reports a failed native token as unavailable and sends nothing", async () => {
      const c = carrier();
      const native = {
        token: vi.fn(async () => {
          throw new Error("no key");
        }),
      };
      await expect(
        createSession(c, () => 1_000_000, native).call("/a", {}),
      ).rejects.toMatchObject({ code: "unavailable", message: "no key" });
      expect(c.post).not.toHaveBeenCalled();
    });

    it("reads window.__beehiveNative when none is passed", async () => {
      const c = carrier();
      vi.stubGlobal("window", {
        __beehiveNative: { token: async () => "injected" },
      });
      try {
        await createSession(c, () => 1_000_000).call("/x", {});
      } finally {
        vi.unstubAllGlobals();
      }
      expect(c.authorize).not.toHaveBeenCalled();
      expect(c.post).toHaveBeenCalledWith(
        "/x",
        {},
        { bearer: "injected" },
        undefined,
      );
    });
  });

  it("uses a native token source injected after the session was created", async () => {
    const c = carrier();
    const session = createSession(c, () => 1_000_000);
    vi.stubGlobal("window", {
      __beehiveNative: { token: async () => "late" },
    });
    try {
      await session.call("/x", {});
    } finally {
      vi.unstubAllGlobals();
    }
    expect(c.authorize).not.toHaveBeenCalled();
    expect(c.post).toHaveBeenCalledWith(
      "/x",
      {},
      { bearer: "late" },
      undefined,
    );
  });

  it("signs in as before when no native token source exists", async () => {
    const c = carrier();
    await createSession(c, () => 1_000_000).call("/x", {});
    expect(c.authorize).toHaveBeenCalledTimes(1);
  });
});
