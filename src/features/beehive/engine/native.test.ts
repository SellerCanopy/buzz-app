import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { nativeCarrier } from "./native";
import { EngineError } from "./transport";

const invokeMock = vi.mocked(invoke);

beforeEach(() => invokeMock.mockReset());

describe("nativeCarrier.post", () => {
  it("reads the reply text as the engine's JSON", async () => {
    invokeMock.mockResolvedValue('{"cards":[]}');
    await expect(nativeCarrier().post("/p", {}, {})).resolves.toEqual({
      cards: [],
    });
  });

  it("reads an empty reply as an empty message", async () => {
    invokeMock.mockResolvedValue("");
    await expect(nativeCarrier().post("/p", {}, {})).resolves.toEqual({});
  });

  it("rejects a reply that is not a JSON object, as the web carrier does", async () => {
    for (const text of ["<html>proxy</html>", "[]", "null"]) {
      invokeMock.mockResolvedValue(text);
      await expect(nativeCarrier().post("/p", {}, {})).rejects.toMatchObject({
        name: "EngineError",
        code: "unavailable",
        message: "Beehive sent an unreadable reply (HTTP 200)",
      });
    }
  });

  it("turns the rejection Rust sends into an EngineError", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "permission_denied",
      message: "no",
      status: 403,
    });
    await expect(nativeCarrier().post("/p", {}, {})).rejects.toMatchObject({
      code: "permission_denied",
      message: "no",
      status: 403,
    });
  });

  it("turns a bare string rejection into an unavailable EngineError", async () => {
    invokeMock.mockRejectedValueOnce("could not reach Beehive");
    await expect(nativeCarrier().post("/p", {}, {})).rejects.toMatchObject({
      code: "unavailable",
      message: "could not reach Beehive",
      status: 0,
    });
  });

  it("gives an empty or missing rejection a message", async () => {
    invokeMock.mockRejectedValueOnce("");
    await expect(nativeCarrier().post("/p", {}, {})).rejects.toMatchObject({
      message: "Beehive did not answer",
    });
    invokeMock.mockRejectedValueOnce(undefined);
    await expect(nativeCarrier().post("/p", {}, {})).rejects.toMatchObject({
      code: "unavailable",
      message: "Beehive did not answer",
      status: 0,
    });
    invokeMock.mockRejectedValueOnce({ code: "unknown", message: "" });
    await expect(nativeCarrier().post("/p", {}, {})).rejects.toMatchObject({
      code: "unknown",
      message: "Beehive did not answer",
    });
  });

  it("does not ask Rust when the caller has already given up", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      nativeCarrier().post("/p", {}, {}, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("lets the caller see its own abort when it gives up during the request", async () => {
    const abort = new AbortController();
    invokeMock.mockImplementation(async () => {
      abort.abort();
      return "{}";
    });
    await expect(
      nativeCarrier().post("/p", {}, {}, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("nativeCarrier.authorize", () => {
  it("prefixes the signed event for the Authorization header", async () => {
    invokeMock.mockResolvedValue("abc");
    await expect(nativeCarrier().authorize()).resolves.toBe("Nostr abc");
  });

  it("reports a signing failure as an EngineError", async () => {
    invokeMock.mockRejectedValueOnce("no key");
    const error = await nativeCarrier()
      .authorize()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ message: "no key" });
  });
});
