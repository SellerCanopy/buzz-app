// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSession } from "../engine/session";
import type { Carrier } from "../engine/transport";
import { nativeToken, SHIM_WAIT_MS } from "./native";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  delete window.__beehiveNative;
});

const carrier = () => {
  const post = vi.fn(async () => ({ ok: true }));
  const authorize = vi.fn(async () => {
    throw new Error("must not sign");
  });
  return { post, authorize } as Carrier & { post: typeof post };
};

it("asks the shim at once when it is already there", async () => {
  const token = vi.fn(async () => "t");
  window.__beehiveNative = { token };
  await expect(nativeToken().token({ refresh: true })).resolves.toBe("t");
  expect(token).toHaveBeenCalledWith({ refresh: true });
});

it("waits for a shim that appears after the first call, and the call succeeds", async () => {
  const c = carrier();
  const session = createSession(c, Date.now, nativeToken());
  const call = session.call("/x", {});
  await vi.advanceTimersByTimeAsync(400);
  expect(c.post).not.toHaveBeenCalled();
  window.__beehiveNative = { token: async () => "late" };
  await vi.advanceTimersByTimeAsync(100);
  await expect(call).resolves.toEqual({ ok: true });
  expect(c.post).toHaveBeenCalledWith("/x", {}, { bearer: "late" }, undefined);
});

it("fails as unavailable, not unauthenticated, when the shim never appears", async () => {
  const c = carrier();
  const call = createSession(c, Date.now, nativeToken()).call("/x", {});
  const failed = expect(call).rejects.toMatchObject({
    code: "unavailable",
    message: "Beehive can only be opened from the Buzz app",
  });
  await vi.advanceTimersByTimeAsync(SHIM_WAIT_MS + 100);
  await failed;
  expect(c.post).not.toHaveBeenCalled();
});

it("gives up after the bound, not before", async () => {
  const token = nativeToken(1_000).token();
  let settled = false;
  token.catch(() => {}).finally(() => (settled = true));
  await vi.advanceTimersByTimeAsync(900);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  expect(settled).toBe(true);
});
