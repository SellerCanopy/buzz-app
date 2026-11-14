import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeReply, EngineError, webCarrier } from "./transport";

afterEach(() => vi.unstubAllGlobals());

function reply(status: number, body: string, statusText = "") {
  return new Response(body, { status, statusText });
}

describe("decodeReply", () => {
  it("parses a JSON body", () => {
    expect(decodeReply(200, "OK", '{"cards":[]}')).toEqual({ cards: [] });
  });
  it("treats an empty success as an empty message", () => {
    expect(decodeReply(200, "OK", "")).toEqual({});
  });
  it("carries the Connect error code, message and status", () => {
    expect(() =>
      decodeReply(
        401,
        "Unauthorized",
        '{"code":"unauthenticated","message":"expired"}',
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "EngineError",
        code: "unauthenticated",
        message: "expired",
        status: 401,
      }),
    );
  });
  it("reports a proxy error page as unavailable", () => {
    expect(() =>
      decodeReply(502, "Bad Gateway", "<html>502</html>"),
    ).toThrowError(
      expect.objectContaining({ code: "unavailable", status: 502 }),
    );
  });
});

describe("webCarrier", () => {
  it("posts JSON with the bearer token", async () => {
    const fetchMock = vi.fn(async () => reply(200, '{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    const out = await webCarrier(
      "https://hive.example.org",
      async () => "x",
    ).post(
      "/kiln.engine.v1.EngineService/ListCards",
      { archived: false },
      { bearer: "tok" },
    );
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hive.example.org/kiln.engine.v1.EngineService/ListCards",
      expect.objectContaining({
        method: "POST",
        body: '{"archived":false}',
        headers: expect.objectContaining({ authorization: "Bearer tok" }),
      }),
    );
  });
  it("sends the signed header as given for the token trade", async () => {
    const fetchMock = vi.fn(async () => reply(200, "{}"));
    vi.stubGlobal("fetch", fetchMock);
    await webCarrier("https://hive.example.org", async () => "x").post(
      "/auth/token",
      {},
      { authorization: "Nostr abc" },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hive.example.org/auth/token",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Nostr abc" }),
      }),
    );
  });
  it("reports a network failure as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("net"))),
    );
    await expect(
      webCarrier("https://hive.example.org", async () => "x").post(
        "/p",
        {},
        {},
      ),
    ).rejects.toBeInstanceOf(EngineError);
  });
});
