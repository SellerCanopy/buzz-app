// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it, vi } from "vitest";
import {
  CardSchema,
  EventSchema,
  RunSchema,
  WorkflowSchema,
  type Card,
  type Run,
  type Workflow,
} from "../gen/kiln/engine/v1/engine_pb";
import type { Client } from "./client";
import { EngineError } from "./transport";
import { applyEvents, touchesRuns, useLive } from "./useLive";

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

/** A client that answers every read from `data` at once, and parks its polls for the test. */
function liveClient(
  data: {
    cards?: Card[];
    archived?: Card[];
    runs?: Run[];
    workflows?: Workflow[];
    seq?: bigint;
    runsSeq?: bigint;
  } = {},
) {
  const polls: {
    after: bigint;
    signal: AbortSignal | undefined;
    resolve(reply: PollReply): void;
    reject(error: Error): void;
  }[] = [];
  const client = {
    listCards: vi.fn(async (archived: boolean) => ({
      cards: (archived ? data.archived : data.cards) ?? [],
      seq: data.seq ?? 5n,
    })),
    listRuns: vi.fn(async () => ({
      runs: data.runs ?? [],
      seq: data.runsSeq ?? 5n,
    })),
    listWorkflows: vi.fn(async () => ({ workflows: data.workflows ?? [] })),
    pollEvents: vi.fn(
      (after: bigint, _wait: number, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          polls.push({ after, signal, resolve, reject });
        }),
    ),
  };
  return { client: client as unknown as Client, calls: client, polls };
}

const ready = (live: ReturnType<typeof useLive>["live"]) =>
  live.status === "ready" ? live : undefined;

it("reads the board, the archive, the runs and the workflows once, and shows them", async () => {
  const run = create(RunSchema, { id: "r1", cardId: "a" });
  const workflow = create(WorkflowSchema, { name: "rpi" });
  const { client, calls } = liveClient({
    cards: [existing],
    archived: [
      create(CardSchema, { id: "z", title: "Shelved", archived: true }),
    ],
    runs: [run],
    workflows: [workflow],
  });
  const { result } = renderHook(() => useLive(client));
  expect(result.current.live.status).toBe("loading");
  await waitFor(() => expect(result.current.live.status).toBe("ready"));
  const live = ready(result.current.live);
  expect(titles(live?.cards ?? [])).toEqual(["Old"]);
  expect(titles(live?.archived ?? [])).toEqual(["Shelved"]);
  expect(live?.runs).toEqual([run]);
  expect(live?.workflows).toEqual([workflow]);
  expect(calls.listCards).toHaveBeenCalledTimes(2);
  expect(calls.listCards).toHaveBeenCalledWith(false, expect.anything());
  expect(calls.listCards).toHaveBeenCalledWith(true, expect.anything());
  expect(calls.listRuns).toHaveBeenCalledWith("", expect.anything());
  expect(calls.listRuns).toHaveBeenCalledTimes(1);
});

it("follows the event log from the lowest sequence number the reads returned and stops on unmount", async () => {
  const { client, polls } = liveClient({
    cards: [existing],
    seq: 14n,
    runsSeq: 12n,
  });
  const { result, unmount } = renderHook(() => useLive(client));
  await waitFor(() => expect(polls).toHaveLength(1));
  expect(polls[0]?.after).toBe(12n);
  await act(async () => {
    polls[0]?.resolve({
      events: [event("card.created", "b", { title: "New", state: "idle" })],
      nextSeq: 15n,
    });
  });
  await waitFor(() => expect(polls).toHaveLength(2));
  expect(polls[1]?.after).toBe(15n);
  expect(titles(ready(result.current.live)?.cards ?? [])).toEqual([
    "New",
    "Old",
  ]);
  unmount();
  expect(polls[1]?.signal?.aborted).toBe(true);
});

it("moves a card between the board and the archive as events arrive", async () => {
  const { client, polls } = liveClient({ cards: [existing] });
  const { result } = renderHook(() => useLive(client));
  await waitFor(() => expect(polls).toHaveLength(1));
  await act(async () => {
    polls[0]?.resolve({
      events: [event("card.archived", "a", { title: "Old", state: "idle" })],
      nextSeq: 6n,
    });
  });
  expect(titles(ready(result.current.live)?.cards ?? [])).toEqual([]);
  expect(titles(ready(result.current.live)?.archived ?? [])).toEqual(["Old"]);
});

it("keeps the cards when the runs or the workflows cannot be read", async () => {
  const { client, calls } = liveClient({ cards: [existing] });
  calls.listRuns.mockRejectedValue(new Error("no runs"));
  calls.listWorkflows.mockRejectedValue(new Error("no workflows"));
  const { result } = renderHook(() => useLive(client));
  await waitFor(() => expect(result.current.live.status).toBe("ready"));
  const live = ready(result.current.live);
  expect(titles(live?.cards ?? [])).toEqual(["Old"]);
  expect(live?.runs).toBeUndefined();
  expect(live?.workflows).toBeUndefined();
});

it("recognises the events that change a run", () => {
  for (const type of [
    "run.started",
    "run.ended",
    "stage.routed",
    "result.reported",
    "round.ended",
    "card.skipped",
  ])
    expect(touchesRuns([event(type, "a")]), type).toBe(true);
  for (const type of ["card.created", "card.state", "activity.added"])
    expect(touchesRuns([event(type, "a")]), type).toBe(false);
});

it("reads the runs again when a run event goes by, and collapses events that arrive during a read", async () => {
  const first = create(RunSchema, { id: "r1", cardId: "a", state: "running" });
  const { client, calls, polls } = liveClient({
    cards: [existing],
    runs: [first],
  });
  const { result } = renderHook(() => useLive(client));
  await waitFor(() => expect(polls).toHaveLength(1));
  expect(calls.listRuns).toHaveBeenCalledTimes(1);
  const ended = create(RunSchema, { id: "r1", cardId: "a", state: "ended" });
  let release: () => void = () => {};
  calls.listRuns.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ runs: [ended], seq: 7n });
      }) as never,
  );
  await act(async () => {
    polls[0]?.resolve({ events: [event("run.ended", "a")], nextSeq: 6n });
  });
  await waitFor(() => expect(polls).toHaveLength(2));
  // Two more run events while the read is open make one more read, not two.
  await act(async () => {
    polls[1]?.resolve({
      events: [event("run.started", "a"), event("stage.routed", "a")],
      nextSeq: 7n,
    });
  });
  await waitFor(() => expect(polls).toHaveLength(3));
  expect(calls.listRuns).toHaveBeenCalledTimes(2);
  await act(async () => release());
  await waitFor(() => expect(calls.listRuns).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(ready(result.current.live)?.runs?.[0]?.state).toBe("running"),
  );
});

it("reads everything again in place on refresh, and keeps the board with the failure when it fails", async () => {
  const { client, calls } = liveClient({ cards: [existing] });
  const { result } = renderHook(() => useLive(client));
  await waitFor(() => expect(result.current.live.status).toBe("ready"));
  calls.listCards.mockImplementationOnce(async () => ({
    cards: [create(CardSchema, { id: "n", title: "Newer" })],
    seq: 9n,
  }));
  await act(async () => result.current.refresh());
  // The board stayed on screen: it never went back to loading.
  expect(titles(ready(result.current.live)?.cards ?? [])).toEqual(["Newer"]);
  calls.listCards.mockRejectedValueOnce(new Error("Beehive is not reachable"));
  await act(async () => result.current.refresh());
  expect(ready(result.current.live)).toMatchObject({
    stale: "Beehive is not reachable",
  });
  expect(titles(ready(result.current.live)?.cards ?? [])).toEqual(["Newer"]);
});

it("follows the log again from the refresh's own read when the poll is already past it, so no event is lost", async () => {
  const data = { cards: [existing], seq: 5n, runsSeq: 5n };
  const { client, polls } = liveClient(data);
  const { result } = renderHook(() => useLive(client));
  await waitFor(() => expect(polls).toHaveLength(1));
  await act(async () => {
    polls[0]?.resolve({
      events: [event("card.created", "b", { title: "New", state: "idle" })],
      nextSeq: 12n,
    });
  });
  await waitFor(() => expect(polls).toHaveLength(2));
  expect(polls[1]?.after).toBe(12n);

  // The refresh reads a snapshot older than what the poll has applied.
  data.seq = 9n;
  data.runsSeq = 9n;
  await act(async () => result.current.refresh());
  await waitFor(() => expect(polls).toHaveLength(3));
  expect(polls[1]?.signal?.aborted).toBe(true);
  expect(polls[2]?.after).toBe(9n);
  // The snapshot replaced the list, and the replayed events put the newer card back.
  expect(titles(ready(result.current.live)?.cards ?? [])).toEqual(["Old"]);
  await act(async () => {
    polls[2]?.resolve({
      events: [event("card.created", "b", { title: "New", state: "idle" })],
      nextSeq: 12n,
    });
  });
  expect(titles(ready(result.current.live)?.cards ?? [])).toEqual([
    "New",
    "Old",
  ]);
});

it("makes one more read, not one per call, when Refresh is pressed during a read", async () => {
  const { client, calls, polls } = liveClient({ cards: [existing] });
  const { result } = renderHook(() => useLive(client));
  await waitFor(() => expect(polls).toHaveLength(1));
  expect(calls.listCards).toHaveBeenCalledTimes(2);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  calls.listCards.mockImplementation(async () => {
    await gate;
    return { cards: [existing], seq: 5n };
  });
  await act(async () => {
    result.current.refresh();
    result.current.refresh();
    result.current.refresh();
  });
  // Only the first read has begun, and it is held.
  expect(calls.listCards).toHaveBeenCalledTimes(4);
  await act(async () => release());
  // The calls made while it ran are answered by one read, which starts when it ends.
  await waitFor(() => expect(calls.listCards).toHaveBeenCalledTimes(6));
  await act(async () => {});
  expect(calls.listCards).toHaveBeenCalledTimes(6);
});

it("says the read failed and reads again on retry", async () => {
  const { client, calls } = liveClient();
  calls.listCards.mockRejectedValueOnce(new Error("Beehive is not reachable"));
  const { result } = renderHook(() => useLive(client));
  await waitFor(() =>
    expect(result.current.live).toEqual({
      status: "error",
      message: "Beehive is not reachable",
    }),
  );
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.live.status).toBe("ready"));
});

it("pauses after repeated failures, logs the first, and recovers on a success", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { client, polls } = liveClient({ cards: [existing] });
    const { result } = renderHook(() => useLive(client));
    const down = new EngineError("unavailable", "down", 503);
    for (let failure = 1; failure <= 3; failure += 1) {
      await vi.waitFor(() => expect(polls).toHaveLength(failure));
      await act(async () => {
        polls[failure - 1]?.reject(down);
      });
      // Not yet paused for the first two blips.
      expect(ready(result.current.live)?.paused).toBe(
        failure < 3 ? undefined : "Live updates paused: down",
      );
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
    expect(titles(ready(result.current.live)?.cards ?? [])).toEqual(["Old"]);
    await vi.waitFor(() => expect(polls).toHaveLength(4));
    await act(async () => {
      polls[3]?.resolve({ events: [], nextSeq: 5n });
    });
    expect(ready(result.current.live)?.paused).toBeUndefined();
  } finally {
    vi.useRealTimers();
    warn.mockRestore();
  }
});

it("pauses at once when the engine refuses the caller, and stops polling", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { client, calls, polls } = liveClient({ cards: [existing] });
  const { result } = renderHook(() => useLive(client));
  await waitFor(() => expect(polls).toHaveLength(1));
  await act(async () => {
    polls[0]?.reject(new EngineError("permission_denied", "no access", 403));
  });
  expect(ready(result.current.live)?.paused).toBe(
    "Live updates paused: no access",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(polls).toHaveLength(1);
  // Retry reads the lists again and follows the log again.
  act(() => result.current.retry());
  await waitFor(() => expect(calls.listCards).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(polls).toHaveLength(2));
  warn.mockRestore();
});
