import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EngineError } from "./engine/transport";
import {
  EventSchema,
  GetStatusResponseSchema,
  PollEventsResponseSchema,
  PersonSchema,
  type PollEventsResponse,
  WhoAmIResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";
import {
  atLeast,
  BACKSTOP_MS,
  changesLevelOf,
  createLevelStore,
  parseLevel,
  showsDock,
} from "./level";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const answer = (role: string) =>
  create(WhoAmIResponseSchema, {
    role,
    me: create(PersonSchema, { userId: ME }),
  });
const accessEvent = (pubkey: string, seq = 1n) =>
  create(EventSchema, {
    seq,
    type: "access.changed",
    payloadJson: JSON.stringify({ pubkey, level: "run", previous: "read" }),
  });

/** A client whose level the test sets and whose long poll the test answers. */
function fake(role = "read") {
  const state = { role: role as string | Error };
  const polls: {
    after: bigint;
    signal: AbortSignal;
    reply(events: ReturnType<typeof accessEvent>[]): void;
    fail(error: unknown): void;
  }[] = [];
  const client = {
    whoAmI: vi.fn(async () => {
      if (state.role instanceof Error) throw state.role;
      return answer(state.role);
    }),
    getStatus: vi.fn(async () =>
      create(GetStatusResponseSchema, { headSeq: 7n }),
    ),
    pollEvents: vi.fn(
      (after: bigint, _wait: number, signal?: AbortSignal) =>
        new Promise<PollEventsResponse>((resolve, reject) => {
          polls.push({
            after,
            signal: signal as AbortSignal,
            reply: (events) =>
              resolve(
                create(PollEventsResponseSchema, {
                  events,
                  nextSeq: after + BigInt(events.length),
                }),
              ),
            fail: reject,
          });
        }),
    ),
  };
  return { client, state, polls };
}

it("reads a level word the app does not know as None, never as more", () => {
  expect(parseLevel("admin")).toBe("admin");
  expect(parseLevel("owner")).toBe("none");
  expect(parseLevel("")).toBe("none");
  expect(atLeast("run", "read")).toBe(true);
  expect(atLeast("read", "run")).toBe(false);
});

it("shows the dock for a person at Read or above, or when the level cannot be read", () => {
  expect(showsDock({ status: "loading" })).toBe(false);
  expect(showsDock({ status: "ready", level: "none", pubkey: ME })).toBe(false);
  expect(showsDock({ status: "ready", level: "read", pubkey: ME })).toBe(true);
  expect(showsDock({ status: "error", message: "down" })).toBe(true);
});

it("tells an access event that names the person from one that does not", () => {
  expect(changesLevelOf([accessEvent(ME)], ME)).toBe(true);
  expect(changesLevelOf([accessEvent(OTHER)], ME)).toBe(false);
  expect(
    changesLevelOf(
      [create(EventSchema, { type: "card.created", payloadJson: "{}" })],
      ME,
    ),
  ).toBe(false);
  expect(
    changesLevelOf(
      [create(EventSchema, { type: "access.changed", payloadJson: "nope" })],
      ME,
    ),
  ).toBe(false);
});

it("starts loading and then holds the level and pubkey the engine named", async () => {
  const e = fake("run");
  const store = createLevelStore(e.client);
  expect(store.get()).toEqual({ status: "loading" });
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toEqual({ status: "ready", level: "run", pubkey: ME });
  stop();
});

it("follows the log from its head and reads the level again when an event names the person", async () => {
  const e = fake("read");
  const store = createLevelStore(e.client);
  const listener = vi.fn();
  store.subscribe(listener);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(1);
  expect(e.polls[0]?.after).toBe(7n);

  // Someone else's change reads nothing.
  e.polls[0]?.reply([accessEvent(OTHER)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(1);

  e.state.role = "admin";
  e.polls[1]?.reply([accessEvent(ME, 9n)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(2);
  expect(store.get()).toMatchObject({ level: "admin" });
  expect(listener).toHaveBeenCalled();
  // The poll was not rebuilt: reading again costs one WhoAmI.
  expect(e.client.getStatus).toHaveBeenCalledTimes(1);
  stop();
});

it("does not poll at None, starts when raised, and stops when lowered", async () => {
  const e = fake("none");
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.client.pollEvents).not.toHaveBeenCalled();

  e.state.role = "read";
  store.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(1);

  e.state.role = "none";
  store.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls[0]?.signal.aborted).toBe(true);
  expect(store.get()).toMatchObject({ level: "none" });
  stop();
});

it("reads the level again when the poll is refused", async () => {
  const e = fake("run");
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  e.state.role = "none";
  e.polls[0]?.fail(new EngineError("permission_denied", "refused", 403));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ level: "none" });
  stop();
});

it("reads the level again on a long, jittered backstop", async () => {
  const low = fake("none");
  const lowStore = createLevelStore(low.client, () => 0);
  const stopLow = lowStore.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 0.8 - 1);
  expect(low.client.whoAmI).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2);
  expect(low.client.whoAmI).toHaveBeenCalledTimes(2);
  stopLow();

  const high = fake("none");
  const highStore = createLevelStore(high.client, () => 1);
  const stopHigh = highStore.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 1.2 - 1);
  expect(high.client.whoAmI).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2);
  expect(high.client.whoAmI).toHaveBeenCalledTimes(2);
  stopHigh();
});

it("reports an unreadable level, keeps a known one through a failed re-read, and stops with the host", async () => {
  const down = fake("run");
  down.state.role = new Error("Beehive is not reachable");
  const first = createLevelStore(down.client);
  const stopFirst = first.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.get()).toEqual({
    status: "error",
    message: "Beehive is not reachable",
  });
  stopFirst();

  const e = fake("run");
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  e.state.role = new Error("Beehive is not reachable");
  store.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ status: "ready", level: "run" });

  stop();
  expect(e.polls[0]?.signal.aborted).toBe(true);
  const calls = e.client.whoAmI.mock.calls.length;
  await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 3);
  expect(e.client.whoAmI.mock.calls.length).toBe(calls);
});
