import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { conversationFeatures } from "../../app/conversation-features";
import {
  orderPages,
  pagePlacement,
  pagePresentation,
} from "../../app/shell/presentation";
import { HexagonIcon } from "../../shared/design-system/icons";
import { createPluginManager } from "../../plugins/manager";
import type { PluginStorage } from "../../plugins/storage";
import { provideNavigation } from "../navigation/service";
import { PagesService } from "../pages/service";
import { fakeRelay } from "./fake-relay";
import { PAGE_ID, PLUGIN_ID } from "./routes";

const beehive = conversationFeatures.filter(
  ({ manifest }) => manifest.id === PLUGIN_ID,
);
const storage: PluginStorage = {
  getCatalog: vi.fn(async () => ({
    status: "ready" as const,
    externalPluginsPaused: false,
    catalog: { profile: "test", location: "test", plugins: [] },
  })),
  changePlugin: vi.fn(),
  recoverSettings: vi.fn(),
  readModule: vi.fn(async () => ""),
  reloadPlugin: vi.fn(),
};

const roots: Context[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function start() {
  const root = new Context();
  roots.push(root);
  createPluginManager(root, { storage, bundled: [], builtIn: beehive });
  provideNavigation(root);
  root.provide("relay", fakeRelay([]));
  root.provide("conversation", { ui: { Thread: () => null } });
  const pages = new PagesService(root);
  await vi.advanceTimersByTimeAsync(0);
  return pages;
}

it("is a host-owned feature, not a plugin from storage", () => {
  expect(beehive).toHaveLength(1);
  expect(beehive[0]?.manifest.name).toBe("Beehive");
});

it("registers a dock page through the built-in path", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "http://localhost:3100");
  const pages = await start();
  const [page] = pages.snapshot();
  expect(page?.key).toBe(`${PLUGIN_ID}/${PAGE_ID}`);
  expect(page).toMatchObject({
    title: "Beehive",
    primary: true,
    placement: "dock",
    layout: "workspace",
  });
  expect(page && pagePlacement(page)).toBe("dock");
  // The shell names the page by its key, so a rename here would drop its icon.
  expect(page && pagePresentation(page).icon).toBe(HexagonIcon);
});

it("sits between Channels and Reminders in the dock", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "http://localhost:3100");
  const [page] = (await start()).snapshot();
  if (!page) throw new Error("Beehive did not register");
  const others = ["buzz.channels/channels", "buzz.reminders/reminders"].map(
    (key) => ({ ...page, key }),
  );
  expect(
    orderPages([...others].reverse().concat(page), "dock").map(
      (item) => item.key,
    ),
  ).toEqual(["buzz.channels/channels", page.key, "buzz.reminders/reminders"]);
});

it("registers the route contract that accepts one card by its uuid", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "http://localhost:3100");
  const [page] = (await start()).snapshot();
  const route = page?.route;
  expect(route?.version).toBe(1);
  expect(
    route?.validate({ card: "0b8f4d1e-6c1f-4f0e-9d53-2f3f6a0a1c11" }),
  ).toBe(true);
  expect(route?.validate({ card: "7" })).toBe(false);
  expect(route?.validate({})).toBe(false);
});

it("registers no page when no Beehive address is configured", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "");
  expect((await start()).snapshot()).toEqual([]);
});

it("registers no page for an address that is not https or local", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "http://hive.example.org");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect((await start()).snapshot()).toEqual([]);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
