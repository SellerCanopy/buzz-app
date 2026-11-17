// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Navigation } from "../../navigation/controller";
import type { OpenTarget } from "../../navigation/targets";
import { PAGE_ID, PLUGIN_ID } from "../routes";
import { useHistory } from "./history";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const board: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: PLUGIN_ID,
  pageId: PAGE_ID,
};
const at = (name: string): OpenTarget =>
  ({
    ...board,
    route: { version: 1, params: { card: name } },
  }) as OpenTarget;

type Shown = { entryId: string; target: OpenTarget; signal: AbortSignal };
const shown = (h: ReturnType<typeof useHistory>) =>
  h.navigation as unknown as Shown;
const only = (target: OpenTarget) => (visit: OpenTarget) => visit === target;

/** The navigator with the back and forward the page itself never calls. */
const setup = (strict = false) => {
  const hook = renderHook(() => useHistory(), {
    ...(strict && { wrapper: StrictMode }),
  });
  const nav = () => hook.result.current.navigator as Navigation;
  const open = (target: OpenTarget) => act(() => nav().open(target));
  return { ...hook, nav, open };
};

it("starts on the board", () => {
  const { result } = setup();
  expect(shown(result.current).target).toEqual(board);
});

it("falls back to a new entry when no entry is left", async () => {
  const { result, nav, open } = setup();
  const first = shown(result.current).entryId;
  await open(at("a"));
  act(() => nav().dismiss(() => true, board));
  expect(shown(result.current).target).toEqual(board);
  expect(shown(result.current).entryId).not.toBe(first);
});

it("keeps the visit on screen when another entry is retired", async () => {
  const { result, nav, open } = setup();
  const a = at("a");
  await open(a);
  await open(at("b"));
  const current = shown(result.current).entryId;
  act(() => nav().dismiss(only(a), board));
  expect(shown(result.current).entryId).toBe(current);
});

it("goes to the entry before when the current one is retired, with several before it", async () => {
  const { result, nav, open } = setup();
  const [a, b, c] = [at("a"), at("b"), at("c")] as [
    OpenTarget,
    OpenTarget,
    OpenTarget,
  ];
  await open(a);
  await open(b);
  await open(c);
  act(() => nav().dismiss(only(c), board));
  expect(shown(result.current).target).toEqual(b);
  act(() => nav().dismiss(only(b), board));
  expect(shown(result.current).target).toEqual(a);
});

it("drops the forward entries when it opens from the middle of the history", async () => {
  const { result, nav, open } = setup();
  const [a, b, c, d] = [at("a"), at("b"), at("c"), at("d")] as [
    OpenTarget,
    OpenTarget,
    OpenTarget,
    OpenTarget,
  ];
  await open(a);
  await open(b);
  await open(c);
  act(() => nav().back());
  act(() => nav().back());
  expect(shown(result.current).target).toEqual(a);
  await open(d);
  expect(shown(result.current).target).toEqual(d);
  // Forward has nowhere to go: b and c were dropped.
  act(() => nav().forward());
  expect(shown(result.current).target).toEqual(d);
  act(() => nav().back());
  expect(shown(result.current).target).toEqual(a);
});

it("keeps a visit's signal live across re-renders and ends it on the move away", async () => {
  const { result, rerender, open } = setup();
  const first = shown(result.current).signal;
  rerender();
  rerender();
  act(() => vi.runAllTimers());
  expect(shown(result.current).signal).toBe(first);
  expect(first.aborted).toBe(false);
  await open(at("a"));
  expect(first.aborted).toBe(false);
  act(() => vi.runAllTimers());
  expect(first.aborted).toBe(true);
  expect(shown(result.current).signal.aborted).toBe(false);
});

it("keeps the first visit's signal live under Strict Mode's remount", () => {
  const { result } = setup(true);
  act(() => vi.runAllTimers());
  expect(shown(result.current).signal.aborted).toBe(false);
});

it("gives each entry its own id without crypto.randomUUID", async () => {
  vi.stubGlobal("crypto", {});
  try {
    const { result, open } = setup();
    const first = shown(result.current).entryId;
    await open(at("a"));
    expect(shown(result.current).entryId).not.toBe(first);
  } finally {
    vi.unstubAllGlobals();
  }
});
