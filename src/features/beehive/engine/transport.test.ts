import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeReply, webCarrier } from "./transport";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
  it("reads a reply that is not a JSON object as unavailable, even on success", () => {
    for (const text of ["<html>login</html>", "[]", "null", "7"]) {
      expect(() => decodeReply(200, "OK", text)).toThrowError(
        expect.objectContaining({
          code: "unavailable",
          message: "Beehive sent an unreadable reply (HTTP 200)",
          status: 200,
        }),
      );
    }
  });
  it("words an error with no message from its status text, then its code", () => {
    expect(() => decodeReply(500, "Server Error", "{}")).toThrowError(
      expect.objectContaining({ code: "unknown", message: "Server Error" }),
    );
    expect(() =>
      decodeReply(404, "", '{"code":"not_found","message":""}'),
    ).toThrowError(expect.objectContaining({ message: "not_found" }));
  });
  it("says Beehive did not answer for an empty failure with no status text", () => {
    expect(() => decodeReply(503, "", "")).toThrowError(
      expect.objectContaining({
        code: "unavailable",
        message: "Beehive did not answer",
        status: 503,
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
  it("reports a network failure as unavailable with status 0", async () => {
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
    ).rejects.toMatchObject({
      name: "EngineError",
      code: "unavailable",
      status: 0,
      message: "Beehive is not reachable",
    });
  });
  it("sends the JSON headers and no authorization when it has none", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => reply(200, "{}"));
    vi.stubGlobal("fetch", fetchMock);
    await webCarrier("https://hive.example.org", async () => "x").post(
      "/p",
      {},
      {},
    );
    const init = fetchMock.mock.calls[0]?.[1] as { headers: object };
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "connect-protocol-version": "1",
    });
  });
  it("lets the caller see its own abort rather than an EngineError", async () => {
    const abort = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
        abort.abort();
        throw init.signal.reason;
      }),
    );
    await expect(
      webCarrier("https://hive.example.org", async () => "x").post(
        "/p",
        {},
        {},
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  /** Make the carrier's timeout signal one the test fires, and record how long it asked for. */
  function controlTimeout() {
    const timeout = new AbortController();
    const asked: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms);
      return timeout.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener("abort", () =>
              reject(init.signal.reason),
            ),
          ),
      ),
    );
    return {
      asked,
      fire: () => timeout.abort(new DOMException("t", "TimeoutError")),
    };
  }
  it("says Beehive did not answer in time when the request times out", async () => {
    const { asked, fire } = controlTimeout();
    const call = webCarrier("https://hive.example.org", async () => "x").post(
      "/kiln.engine.v1.EngineService/ListCards",
      {},
      {},
    );
    fire();
    await expect(call).rejects.toMatchObject({
      code: "unavailable",
      status: 0,
      message: "Beehive did not answer in time",
    });
    expect(asked).toEqual([15_000]);
  });
  it("gives a long poll longer than any other call before timing out", async () => {
    const { asked, fire } = controlTimeout();
    const call = webCarrier("https://hive.example.org", async () => "x").post(
      "/kiln.engine.v1.EngineService/PollEvents",
      {},
      {},
    );
    fire();
    await expect(call).rejects.toMatchObject({
      message: "Beehive did not answer in time",
    });
    expect(asked).toEqual([30_000]);
  });
  it("reports a body that stops arriving as Beehive stopped answering", async () => {
    const broken = {
      status: 200,
      statusText: "OK",
      text: () => Promise.reject(new TypeError("terminated")),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => broken),
    );
    await expect(
      webCarrier("https://hive.example.org", async () => "x").post(
        "/p",
        {},
        {},
      ),
    ).rejects.toMatchObject({
      code: "unavailable",
      status: 200,
      message: "Beehive stopped answering",
    });
  });
});
