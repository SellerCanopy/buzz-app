import { expect, it } from "vitest";
import {
  PAGE_ID,
  PLUGIN_ID,
  boardTarget,
  cardTarget,
  routeCard,
  visitedCard,
} from "./routes";

const ID = "0b8f4d1e-6c1f-4f0e-9d53-2f3f6a0a1c11";
const board = {
  version: 1,
  kind: "page",
  pluginId: PLUGIN_ID,
  pageId: PAGE_ID,
} as const;

it("accepts only a route naming one card by its uuid", () => {
  expect(routeCard({ card: ID })).toBe(ID);
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
