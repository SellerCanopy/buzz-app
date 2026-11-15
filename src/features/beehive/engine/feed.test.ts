import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  EventSchema,
  PollEventsResponseSchema,
  type PollEventsResponse,
} from "../gen/kiln/engine/v1/engine_pb";
import { createFeed, feedOf } from "./feed";
import { EngineError } from "./transport";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A client whose long polls the test answers one by one. */
function fake() {
  const polls: {
    after: bigint;
    signal: AbortSignal;
    reply(types: string[]): void;
    fail(error: unknown): void;
  }[] = [];
  const client = {
    pollEvents: vi.fn(
      (after: bigint, _wait: number, signal?: AbortSignal) =>
        new Promise<PollEventsResponse>((resolve, reject) => {
          polls.push({
            after,
            signal: signal as AbortSignal,
            reply: (types) =>
              resolve(
                create(PollEventsResponseSchema, {
                  events: types.map((type, index) =>
                    create(EventSchema, {
                      seq: after + BigInt(index + 1),
                      type,
                    }),
                  ),
                  nextSeq: after + BigInt(types.length),
                }),
              ),
            fail: reject,
          });
        }),
    ),
  };
  return { client, polls };
}

const types = (calls: { mock: { calls: unknown[][] } }) =>
  calls.mock.calls.map((call) =>
    (call[0] as { type: string }[]).map((event) => event.type),
  );

it("serves every follower from one poll", async () => {
  const e = fake();
  const feed = createFeed(e.client);
  const first = vi.fn();
  const second = vi.fn();
  feed.follow({ after: 10n, onEvents: first });
  feed.follow({ after: 10n, onEvents: second });
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(1);

  e.polls[0]?.reply(["inbox.opened", "card.state"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(types(first)).toEqual([["inbox.opened", "card.state"]]);
  expect(types(second)).toEqual([["inbox.opened", "card.state"]]);
  expect(e.polls).toHaveLength(2);
  expect(e.polls[1]?.after).toBe(12n);
});

it("restarts from an earlier cursor for a follower that read before the poll got there", async () => {
  const e = fake();
  const feed = createFeed(e.client);
  const early = vi.fn();
  const late = vi.fn();
  feed.follow({ after: 10n, onEvents: early });
  await vi.advanceTimersByTimeAsync(0);
  e.polls[0]?.reply(["card.state"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls[1]?.after).toBe(11n);

  // A read that returned 10 needs event 11, which the poll has already passed.
  feed.follow({ after: 10n, onEvents: late });
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls[1]?.signal.aborted).toBe(true);
  expect(e.polls[2]?.after).toBe(10n);

  // A follower from a later read does not restart it.
  feed.follow({ after: 50n, onEvents: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(3);
});

it("stops with the last follower and starts again for the next", async () => {
  const e = fake();
  const feed = createFeed(e.client);
  const stopFirst = feed.follow({ after: 1n, onEvents: vi.fn() });
  const stopSecond = feed.follow({ after: 1n, onEvents: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  stopFirst();
  expect(e.polls[0]?.signal.aborted).toBe(false);
  stopSecond();
  expect(e.polls[0]?.signal.aborted).toBe(true);

  feed.follow({ after: 4n, onEvents: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls[1]?.after).toBe(4n);
});

it("tells every follower about a refusal, drops them, and starts again for a new one", async () => {
  const e = fake();
  const feed = createFeed(e.client);
  const first = vi.fn();
  const second = vi.fn();
  feed.follow({ after: 1n, onEvents: vi.fn(), onError: first });
  feed.follow({ after: 1n, onEvents: vi.fn(), onError: second });
  await vi.advanceTimersByTimeAsync(0);
  const refusal = new EngineError("permission_denied", "refused", 403);
  e.polls[0]?.fail(refusal);
  await vi.advanceTimersByTimeAsync(0);
  expect(first).toHaveBeenCalledWith(refusal, 1, true);
  expect(second).toHaveBeenCalledWith(refusal, 1, true);
  expect(e.polls).toHaveLength(1);

  feed.follow({ after: 1n, onEvents: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  expect(e.polls).toHaveLength(2);
});

it("keeps followers through a failure retrying can cure, and tells them when it recovers", async () => {
  const e = fake();
  const feed = createFeed(e.client);
  const onError = vi.fn();
  const onRecover = vi.fn();
  feed.follow({ after: 1n, onEvents: vi.fn(), onError, onRecover });
  await vi.advanceTimersByTimeAsync(0);
  e.polls[0]?.fail(new EngineError("unavailable", "down", 503));
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith(expect.anything(), 1, false);
  await vi.advanceTimersByTimeAsync(30_000);
  e.polls[1]?.reply(["card.state"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(onRecover).toHaveBeenCalledTimes(1);
});

it("gives one feed to a client", () => {
  const e = fake();
  expect(feedOf(e.client)).toBe(feedOf(e.client));
  expect(feedOf(e.client)).not.toBe(feedOf(fake().client));
});
