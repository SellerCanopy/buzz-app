// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { OpenTarget } from "../../navigation/targets";
import { PAGE_ID, PLUGIN_ID } from "../routes";
import { useHistory } from "./history";

const board: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: PLUGIN_ID,
  pageId: PAGE_ID,
};
const card: OpenTarget = {
  ...board,
  route: { version: 1, params: { card: "c" } },
} as OpenTarget;

const target = (h: ReturnType<typeof useHistory>) =>
  (h.navigation as unknown as { target: OpenTarget }).target;

it("starts on the board", () => {
  const { result } = renderHook(() => useHistory());
  expect(target(result.current)).toEqual(board);
});

it("opens a card and returns to the board when its visits are dismissed", async () => {
  const { result } = renderHook(() => useHistory());
  await act(() => result.current.navigator.open(card));
  expect(target(result.current)).toEqual(card);
  act(() => result.current.navigator.dismiss((visit) => visit === card, board));
  expect(target(result.current)).toEqual(board);
});

it("ends a visit's signal when the page moves off it", async () => {
  const { result } = renderHook(() => useHistory());
  const first = (
    result.current.navigation as unknown as { signal: AbortSignal }
  ).signal;
  expect(first.aborted).toBe(false);
  await act(() => result.current.navigator.open(card));
  expect(first.aborted).toBe(true);
});
