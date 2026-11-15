import { beforeEach, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ desktop: false }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauri.desktop,
  invoke: vi.fn(async (cmd: string) =>
    cmd === "beehive_authorization" ? "b64" : '{"cards":[]}',
  ),
}));

import { invoke } from "@tauri-apps/api/core";
import { chooseCarrier } from "./carrier";

beforeEach(() => {
  tauri.desktop = false;
  vi.mocked(invoke).mockClear();
});

it("uses the native carrier in the desktop app", async () => {
  const carrier = chooseCarrier("https://hive.example.org", true);
  expect(await carrier.authorize()).toBe("Nostr b64");
  expect(await carrier.post("/p", {}, { bearer: "t" })).toEqual({ cards: [] });
  expect(invoke).toHaveBeenLastCalledWith("beehive_request", {
    path: "/p",
    body: "{}",
    bearer: "t",
    authorization: null,
  });
});

it("uses the web carrier, which needs a signer, in a browser", async () => {
  const carrier = chooseCarrier("https://hive.example.org", false);
  await expect(carrier.authorize()).rejects.toMatchObject({
    code: "unauthenticated",
  });
});

it("asks the runtime which carrier to use when none is named", async () => {
  tauri.desktop = true;
  expect(await chooseCarrier("https://hive.example.org").authorize()).toBe(
    "Nostr b64",
  );
  tauri.desktop = false;
  await expect(
    chooseCarrier("https://hive.example.org").authorize(),
  ).rejects.toMatchObject({ code: "unauthenticated" });
});
