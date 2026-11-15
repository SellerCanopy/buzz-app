import { expect, it } from "vitest";
import { parseBuzzLink } from "../navigation/buzz-links";
import { linkedPage, linkedPageTarget } from "../pages/plugin-link";
import type { RegisteredPage } from "../pages/service";
import {
  PAGE_ID,
  PAGE_ROUTE,
  PLUGIN_ID,
  boardTarget,
  cardTarget,
  routeCard,
  routeTab,
  visitedCard,
  visitedTab,
} from "./routes";

const ID = "0b8f4d1e-6c1f-4f0e-9d53-2f3f6a0a1c11";
const board = {
  version: 1,
  kind: "page",
  pluginId: PLUGIN_ID,
  pageId: PAGE_ID,
} as const;

it("accepts only a route naming one card by its uuid and, optionally, a known tab", () => {
  expect(routeCard({ card: ID })).toBe(ID);
  expect(routeCard({ card: ID, tab: "live" })).toBe(ID);
  expect(routeCard({ card: ID, tab: "activity" })).toBe(ID);
  expect(routeCard({ card: ID, tab: "nope" })).toBeUndefined();
  expect(routeCard({ tab: "live" })).toBeUndefined();
  expect(routeCard({ card: "7" })).toBeUndefined();
  expect(routeCard({ card: ID, extra: "x" })).toBeUndefined();
  expect(routeCard({})).toBeUndefined();
  expect(routeCard(undefined)).toBeUndefined();
  expect(routeCard([ID])).toBeUndefined();
});

it("round-trips a card through its target and back to the board", () => {
  const target = cardTarget(board, ID);
  expect(visitedCard(target)).toBe(ID);
  expect(visitedCard(board)).toBeUndefined();
  expect(boardTarget(board)).toEqual(board);
  expect(visitedCard(boardTarget(target as typeof board))).toBeUndefined();
});

it("does not read another page's route as a card", () => {
  expect(
    visitedCard({
      ...board,
      pageId: "other",
      route: { version: 1, params: { card: ID } },
    }),
  ).toBeUndefined();
});

it("carries the tab in the target and reads it back", () => {
  const target = cardTarget(board, ID, "steps");
  expect(visitedCard(target)).toBe(ID);
  expect(visitedTab(target)).toBe("steps");
  expect(visitedTab(cardTarget(board, ID))).toBeUndefined();
  expect(visitedTab(board)).toBeUndefined();
  expect(routeTab({ card: ID, tab: "nope" })).toBeUndefined();
});

// The same link the engine ends its first post of every stage thread with.
const CARD_LINK = `buzz://plugin?id=${PLUGIN_ID}&page=${PAGE_ID}&route.card=${ID}`;
const page = {
  pluginId: PLUGIN_ID,
  id: PAGE_ID,
  primary: true,
  // The contract the module registers, not a copy of it.
  route: PAGE_ROUTE,
} as unknown as RegisteredPage;

it("opens the card the engine's link names", () => {
  const link = parseBuzzLink(CARD_LINK);
  expect(link).toMatchObject({ format: "plugin", pluginId: PLUGIN_ID });
  if (link?.format !== "plugin") throw new Error("not a plugin link");
  const { format: _format, ...plugin } = link;
  const target = { version: 1, kind: "plugin", ...plugin } as const;
  expect(linkedPage([page], target)).toBe(page);
  expect(visitedCard(linkedPageTarget(target, page))).toBe(ID);
});

it("opens the board, not a card, for a link naming no valid card", () => {
  const link = parseBuzzLink(CARD_LINK.replace(ID, "7"));
  if (link?.format !== "plugin") throw new Error("not a plugin link");
  const { format: _format, ...plugin } = link;
  const target = { version: 1, kind: "plugin", ...plugin } as const;
  expect(visitedCard(linkedPageTarget(target, page))).toBeUndefined();
});
