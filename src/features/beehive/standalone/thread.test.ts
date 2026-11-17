import { afterEach, expect, it, vi } from "vitest";
import { openNativeThread } from "./thread";

afterEach(() => vi.unstubAllGlobals());

it("hands the thread to the app's thread view", () => {
  const openThread = vi.fn();
  vi.stubGlobal("window", {
    __beehiveNative: { token: async () => "t", openThread },
  });
  openNativeThread("channel", "root");
  expect(openThread).toHaveBeenCalledWith("channel", "root");
});

it("does nothing when the app has no thread view", () => {
  vi.stubGlobal("window", { __beehiveNative: { token: async () => "t" } });
  expect(() => openNativeThread("channel", "root")).not.toThrow();
  vi.stubGlobal("window", {});
  expect(() => openNativeThread("channel", "root")).not.toThrow();
});
