// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it, vi } from "vitest";
import {
  CardSchema,
  EventSchema,
  type Card,
} from "../gen/kiln/engine/v1/engine_pb";
import type { Client } from "./client";
import { EngineError } from "./transport";
import { applyEvents, useLive } from "./useLive";

const event = (type: string, cardId: string, payload: object = {}) =>
  create(EventSchema, {
    type,
    cardId,
    seq: 1n,
    payloadJson: JSON.stringify(payload),
  });
const titles = (cards: Card[]) => cards.map((c) => c.title);
const existing = create(CardSchema, { id: "a", title: "Old", state: "idle" });

it("puts a created card first on the board and not in the archive", () => {
  const created = event("card.created", "b", {
    title: "New",
    workflow: "",
    state: "idle",
  });
  expect(titles(applyEvents([existing], [created], false))).toEqual([
    "New",
    "Old",
  ]);
  expect(applyEvents([], [created], true)).toEqual([]);
});

it("is idempotent: the same events twice leave the same list", () => {
  const events = [
    event("card.created", "b", { title: "New", workflow: "", state: "idle" }),
    event("card.state", "b", { state: "running" }),
    event("card.moved", "b", { workflow: "ship" }),
  ];
  const once = applyEvents([existing], events, false);
  const twice = applyEvents(once, events, false);
  expect(twice).toEqual(once);
  expect(once[0]).toMatchObject({
    id: "b",
    state: "running",
    workflow: "ship",
  });
});

it("moves a card between the board and the archive", () => {
  const archived = event("card.archived", "a", { title: "Old" });
  expect(applyEvents([existing], [archived], false)).toEqual([]);
  const inArchive = applyEvents([], [archived], true);
  expect(inArchive[0]).toMatchObject({ id: "a", archived: true });
  const restored = event("card.restored", "a", { title: "Old" });
  expect(applyEvents(inArchive, [restored], true)).toEqual([]);
  expect(applyEvents([], [restored], false)[0]).toMatchObject({
    id: "a",
    archived: false,
  });
});

it("removes a deleted card from either view and ignores unknown events", () => {
  expect(applyEvents([existing], [event("card.removed", "a")], false)).toEqual(
    [],
  );
  const unknown = event("run.started", "a");
  expect(applyEvents([existing], [unknown], false)).toEqual([existing]);
});

it("applies a change in order when a card is created and archived in one batch", () => {
  const batch = [
    event("card.created", "b", { title: "New", state: "idle" }),
    event("card.archived", "b", { title: "New", state: "idle" }),
  ];
  expect(applyEvents([], batch, false)).toEqual([]);
  expect(titles(applyEvents([], batch, true))).toEqual(["New"]);
});

afterEach(cleanup);

type PollReply = { events: ReturnType<typeof event>[]; nextSeq: bigint };

/** A client whose reads the test answers by hand, and that records what it was asked. */
function liveClient() {
  const lists: {
    archived: boolean;
    signal: AbortSignal | undefined;
    resolve(cards: Card[], seq?: bigint): void;
    reject(error: Error): void;
  }[] = [];
  const polls: {
    after: bigint;
    signal: AbortSignal | undefined;
    resolve(reply: PollReply): void;
    reject(error: Error): void;
  }[] = [];
  const client = {
    listCards: vi.fn(
      (archived: boolean, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          lists.push({
            archived,
            signal,
            resolve: (cards, seq = 5n) => resolve({ cards, seq }),
            reject,
          });
        }),
    ),
    pollEvents: vi.fn(
      (after: bigint, _wait: number, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          polls.push({ after, signal, resolve, reject });
        }),
    ),
  } as unknown as Client;
  return { client, lists, polls };
}

it("shows the cards of the latest read when an earlier one answers late", async () => {
  const { client, lists } = liveClient();
  const { result, rerender } = renderHook(
    ({ archived }) => useLive(client, archived),
    { initialProps: { archived: false } },
  );
  await waitFor(() => expect(lists).toHaveLength(1));
  rerender({ archived: true });
  await waitFor(() => expect(lists).toHaveLength(2));
  expect(lists[0]?.signal?.aborted).toBe(true);
  // The board's read answers after the person has moved on to the archive.
  await act(async () => {
    lists[0]?.resolve([create(CardSchema, { id: "board", title: "Board" })]);
  });
  expect(result.current.live.status).toBe("loading");
  await act(async () => {
    lists[1]?.resolve([create(CardSchema, { id: "old", title: "Archived" })]);
  });
  expect(result.current.live).toMatchObject({ status: "ready" });
  expect(
    result.current.live.status === "ready" && titles(result.current.live.cards),
  ).toEqual(["Archived"]);
});

it("follows the event log from the sequence number the read returned and stops on unmount", async () => {
  const { client, lists, polls } = liveClient();
  const { result, unmount } = renderHook(() => useLive(client, false));
  await waitFor(() => expect(lists).toHaveLength(1));
  await act(async () => {
    lists[0]?.resolve([existing], 12n);
  });
  await waitFor(() => expect(polls).toHaveLength(1));
  expect(polls[0]?.after).toBe(12n);
  await act(async () => {
    polls[0]?.resolve({
      events: [event("card.created", "b", { title: "New", state: "idle" })],
      nextSeq: 13n,
    });
  });
  await waitFor(() => expect(polls).toHaveLength(2));
  expect(polls[1]?.after).toBe(13n);
  expect(
    result.current.live.status === "ready" && titles(result.current.live.cards),
  ).toEqual(["New", "Old"]);
  unmount();
  expect(polls[1]?.signal?.aborted).toBe(true);
});

it("says the read failed and reads again on retry", async () => {
  const { client, lists } = liveClient();
  const { result } = renderHook(() => useLive(client, false));
  await waitFor(() => expect(lists).toHaveLength(1));
  await act(async () => {
    lists[0]?.reject(new Error("Beehive is not reachable"));
  });
  expect(result.current.live).toEqual({
    status: "error",
    message: "Beehive is not reachable",
  });
  act(() => result.current.retry());
  await waitFor(() => expect(lists).toHaveLength(2));
  expect(result.current.live.status).toBe("loading");
});

it("pauses after repeated failures, logs the first, and recovers on a success", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { client, lists, polls } = liveClient();
    const { result } = renderHook(() => useLive(client, false));
    await vi.waitFor(() => expect(lists).toHaveLength(1));
    await act(async () => {
      lists[0]?.resolve([existing]);
    });
    const down = new EngineError("unavailable", "down", 503);
    for (let failure = 1; failure <= 3; failure += 1) {
      await vi.waitFor(() => expect(polls).toHaveLength(failure));
      await act(async () => {
        polls[failure - 1]?.reject(down);
      });
      // Not yet paused for the first two blips.
      expect(
        result.current.live.status === "ready" && result.current.live.paused,
      ).toBe(failure < 3 ? undefined : "Live updates paused: down");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Beehive live updates failed", {
      code: "unavailable",
      status: 503,
      failures: 1,
      terminal: false,
    });
    // The cards stay while paused.
    expect(
      result.current.live.status === "ready" &&
        titles(result.current.live.cards),
    ).toEqual(["Old"]);
    await vi.waitFor(() => expect(polls).toHaveLength(4));
    await act(async () => {
      polls[3]?.resolve({ events: [], nextSeq: 5n });
    });
    expect(
      result.current.live.status === "ready" && result.current.live.paused,
    ).toBeUndefined();
  } finally {
    vi.useRealTimers();
    warn.mockRestore();
  }
});

it("pauses at once when the engine refuses the caller, and stops polling", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { client, lists, polls } = liveClient();
  const { result } = renderHook(() => useLive(client, false));
  await waitFor(() => expect(lists).toHaveLength(1));
  await act(async () => {
    lists[0]?.resolve([existing]);
  });
  await waitFor(() => expect(polls).toHaveLength(1));
  await act(async () => {
    polls[0]?.reject(new EngineError("permission_denied", "no access", 403));
  });
  expect(
    result.current.live.status === "ready" && result.current.live.paused,
  ).toBe("Live updates paused: no access");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(polls).toHaveLength(1);
  // Retry reads the list again and follows the log again.
  act(() => result.current.retry());
  await waitFor(() => expect(lists).toHaveLength(2));
  warn.mockRestore();
});
