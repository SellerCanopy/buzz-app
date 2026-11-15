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
  assignable,
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

/** A promise the test settles by hand. */
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("reads the level once when the poll is refused and does not follow again at the same level", async () => {
  const e = fake("run");
  const store = createLevelStore(e.client, () => 1);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(1);

  // The engine keeps refusing the poll while WhoAmI still says Run.
  e.polls[0]?.fail(new EngineError("failed_precondition", "refused", 400));
  await vi.advanceTimersByTimeAsync(0);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(2);
  expect(e.polls).toHaveLength(1);
  expect(e.client.getStatus).toHaveBeenCalledTimes(1);

  // Nothing loops: no further request until the backstop.
  await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 0.5);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(2);
  expect(e.polls).toHaveLength(1);

  // The backstop tries the poll again.
  await vi.advanceTimersByTimeAsync(BACKSTOP_MS);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(3);
  expect(e.polls).toHaveLength(2);
  stop();
});

it("follows again after a refused poll when the level changed", async () => {
  const e = fake("read");
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  e.state.role = "admin";
  e.polls[0]?.fail(new EngineError("permission_denied", "refused", 403));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ level: "admin" });
  expect(e.polls).toHaveLength(2);
  stop();
});

it("a person asking again follows a poll the engine refused", async () => {
  const e = fake("run");
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  e.polls[0]?.fail(new EngineError("invalid_argument", "refused", 400));
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(1);
  store.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(2);
  stop();
});

it("takes the event cursor before it reads the level, so a change in between is replayed", async () => {
  const e = fake("read");
  e.client.getStatus
    .mockResolvedValueOnce(create(GetStatusResponseSchema, { headSeq: 7n }))
    .mockResolvedValue(create(GetStatusResponseSchema, { headSeq: 99n }));
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls[0]?.after).toBe(7n);
  expect(e.client.getStatus).toHaveBeenCalledTimes(1);
  const first = e.client.getStatus.mock.invocationCallOrder[0] ?? 0;
  const second = e.client.whoAmI.mock.invocationCallOrder[0] ?? 0;
  expect(first).toBeLessThan(second);
  stop();
});

it("takes the cursor after the level for a person who was at None, who could not read it before", async () => {
  const e = fake("none");
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  e.state.role = "read";
  store.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(1);
  expect(e.polls[0]?.after).toBe(7n);
  stop();
});

it("collapses reads asked for while one is out into one more", async () => {
  const e = fake("none");
  const held = gate<ReturnType<typeof answer>>();
  e.client.whoAmI.mockImplementationOnce(() => held.promise);
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(1);
  store.refresh();
  store.refresh();
  store.refresh();
  expect(e.client.whoAmI).toHaveBeenCalledTimes(1);
  held.resolve(answer("none"));
  await vi.advanceTimersByTimeAsync(0);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(2);
  stop();
});

it("keeps the level and starts following on a later read when the status cannot be read", async () => {
  const e = fake("read");
  // Once before the level and once after it: both fail.
  e.client.getStatus
    .mockRejectedValueOnce(new Error("down"))
    .mockRejectedValueOnce(new Error("down"));
  const store = createLevelStore(e.client, () => 1);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ status: "ready", level: "read" });
  expect(e.polls).toHaveLength(0);

  // It is tried again soon, not on the backstop.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(e.polls).toHaveLength(1);
  stop();
});

it("does not read the level for a poll failure that retrying can cure", async () => {
  const e = fake("run");
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  e.polls[0]?.fail(new EngineError("unavailable", "down", 503));
  await vi.advanceTimersByTimeAsync(0);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(1);
  expect(store.get()).toMatchObject({ level: "run" });
  stop();
});

it("takes the level to None when a re-read is refused outright", async () => {
  const e = fake("admin");
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  e.state.role = new EngineError("permission_denied", "not a member", 403);
  store.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toEqual({ status: "ready", level: "none", pubkey: ME });
  expect(e.polls[0]?.signal.aborted).toBe(true);
  stop();
});

it("says the level cannot be read when the very first read is refused", async () => {
  const e = fake("run");
  e.state.role = new EngineError("unauthenticated", "sign in again", 401);
  const store = createLevelStore(e.client);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toEqual({ status: "error", message: "sign in again" });
  stop();
});

it("tries a failed read again on a capped, growing backoff, not on the backstop", async () => {
  const e = fake("run");
  e.state.role = new Error("Beehive is not reachable");
  const store = createLevelStore(e.client, () => 1);
  const stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(4);
  // The wait stops growing at the cap: about one read every two minutes from here on.
  await vi.advanceTimersByTimeAsync(40_000 + 80_000);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(120_000 * 5);
  expect(e.client.whoAmI).toHaveBeenCalledTimes(11);

  e.state.role = "run";
  await vi.advanceTimersByTimeAsync(120_000);
  expect(store.get()).toMatchObject({ status: "ready", level: "run" });
  stop();
});

it("lets an entry keep its level and refuses what the engine would", () => {
  const person = {
    pubkey: ME,
    kind: "person",
    level: "admin",
    ownerLevel: "admin",
  } as const;
  expect(assignable(person, ME, "admin")).toEqual({ allowed: true });
  expect(assignable(person, ME, "read")).toMatchObject({ allowed: false });
  expect(assignable(person, OTHER, "read")).toEqual({ allowed: true });

  const agent = {
    pubkey: OTHER,
    kind: "agent",
    level: "read",
    ownerLevel: "read",
  } as const;
  expect(assignable(agent, ME, "none")).toEqual({ allowed: true });
  expect(assignable(agent, ME, "read")).toEqual({ allowed: true });
  expect(assignable(agent, ME, "run")).toMatchObject({
    allowed: false,
    reason: "Above its owner's level (Read)",
  });
  expect(assignable(agent, ME, "admin")).toMatchObject({ allowed: false });
});
