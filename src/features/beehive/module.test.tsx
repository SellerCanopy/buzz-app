import { Context } from "@deepseek-ai/cordis";
import { create } from "@bufbuild/protobuf";
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
import { WhoAmIResponseSchema } from "./gen/kiln/engine/v1/engine_pb";
import { BACKSTOP_MS } from "./level";
import { PAGE_ID, PLUGIN_ID } from "./routes";

/** The engine as the module sees it: the level it answers is set by each test. */
const engine = vi.hoisted(() => ({
  role: "run" as string | Error,
  whoAmI: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("./engine/client", () => ({
  createClient: () => ({
    whoAmI: engine.whoAmI,
    getStatus: vi.fn(async () => ({ headSeq: 0n })),
    // A parked poll that only ends when the module stops it.
    pollEvents: vi.fn(
      (_after: bigint, _wait?: number, signal?: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    ),
  }),
}));

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
beforeEach(() => {
  vi.useFakeTimers();
  engine.role = "run";
  engine.whoAmI = vi.fn(async () => {
    if (engine.role instanceof Error) throw engine.role;
    return create(WhoAmIResponseSchema, { role: engine.role });
  });
});
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

it("registers no dock entry for a person at None, and never while the level is unknown", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "http://localhost:3100");
  engine.role = "none";
  const pages = await start();
  expect(pages.snapshot()).toEqual([]);
});

it("registers the dock entry for a person at Read", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "http://localhost:3100");
  engine.role = "read";
  const [page] = (await start()).snapshot();
  expect(page?.key).toBe(`${PLUGIN_ID}/${PAGE_ID}`);
});

it("keeps the dock entry when the level cannot be read, so the page can say so", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "http://localhost:3100");
  engine.role = new Error("Beehive is not reachable");
  expect((await start()).snapshot()).toHaveLength(1);
});

it("takes the entry out of the dock when the level drops to None and puts it back when it rises", async () => {
  vi.stubEnv("VITE_BUZZ_BEEHIVE_URL", "http://localhost:3100");
  engine.role = "run";
  const pages = await start();
  expect(pages.snapshot()).toHaveLength(1);

  engine.role = "none";
  await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 1.3);
  expect(pages.snapshot()).toEqual([]);

  engine.role = "read";
  await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 1.3);
  expect(pages.snapshot()).toHaveLength(1);
});
