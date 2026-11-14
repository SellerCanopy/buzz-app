import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(async (cmd: string) =>
    cmd === "beehive_authorization" ? "b64" : '{"cards":[]}',
  ),
}));

import { chooseCarrier } from "./carrier";

it("uses the native carrier in the desktop app", async () => {
  const carrier = chooseCarrier("https://hive.example.org", true);
  expect(await carrier.authorize()).toBe("Nostr b64");
  expect(await carrier.post("/p", {}, { bearer: "t" })).toEqual({ cards: [] });
});

it("uses the web carrier, which needs a signer, in a browser", async () => {
  const carrier = chooseCarrier("https://hive.example.org", false);
  await expect(carrier.authorize()).rejects.toMatchObject({
    code: "unauthenticated",
  });
});
