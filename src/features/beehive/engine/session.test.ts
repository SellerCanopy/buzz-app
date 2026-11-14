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
});
