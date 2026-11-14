import { describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { EventSchema } from "../gen/kiln/engine/v1/engine_pb";
import { startPoll } from "./poll";

const event = (seq: number) =>
  create(EventSchema, { seq: BigInt(seq), type: "card.created" });

/** A call the test answers one reply at a time. */
function script() {
  const waiting: {
    after: bigint;
    resolve(reply: {
      events: ReturnType<typeof event>[];
      nextSeq: bigint;
    }): void;
    reject(error: Error): void;
  }[] = [];
  const call = vi.fn(
    (after: bigint, signal: AbortSignal) =>
      new Promise<{ events: ReturnType<typeof event>[]; nextSeq: bigint }>(
        (resolve, reject) => {
          waiting.push({ after, resolve, reject });
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        },
      ),
  );
  const next = async () => {
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    const reply = waiting.shift();
    if (!reply) throw new Error("no call is waiting");
    return reply;
  };
  return { call, next };
}

describe("startPoll", () => {
  it("asks from the cursor, delivers events and moves the cursor to next_seq", async () => {
    const { call, next } = script();
    const onEvents = vi.fn();
    const poll = startPoll({ after: 7n, call, onEvents });
    (await next()).resolve({ events: [event(8), event(9)], nextSeq: 9n });
    const second = await next();
    expect(second.after).toBe(9n);
    expect(onEvents).toHaveBeenCalledWith([event(8), event(9)]);
    poll.stop();
  });

  it("does not deliver an empty reply and polls again from the same cursor", async () => {
    const { call, next } = script();
    const onEvents = vi.fn();
    const poll = startPoll({ after: 3n, call, onEvents });
    (await next()).resolve({ events: [], nextSeq: 3n });
    expect((await next()).after).toBe(3n);
    expect(onEvents).not.toHaveBeenCalled();
    poll.stop();
  });

  it("resumes from the cursor after a failure, waiting random() * ceiling first", async () => {
    const { call, next } = script();
    const sleeps: number[] = [];
    const poll = startPoll({
      after: 0n,
      call,
      onEvents: () => {},
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    (await next()).resolve({ events: [event(1)], nextSeq: 1n });
    (await next()).reject(new Error("down"));
    const retry = await next();
    expect(retry.after).toBe(1n);
    // First failure: ceiling 500 * 2 = 1000 ms.
    expect(sleeps).toEqual([500]);
    poll.stop();
  });

  it("never waits longer than 30 s and starts the ceiling over after a success", async () => {
    const { call, next } = script();
    const sleeps: number[] = [];
    const poll = startPoll({
      after: 0n,
      call,
      onEvents: () => {},
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    for (let i = 0; i < 9; i += 1) (await next()).reject(new Error("down"));
    (await next()).resolve({ events: [], nextSeq: 0n });
    (await next()).reject(new Error("down"));
    await next();
    expect(sleeps.slice(0, 7)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30_000, 30_000,
    ]);
    expect(sleeps.every((ms) => ms <= 30_000)).toBe(true);
    expect(sleeps.at(-1)).toBe(1000);
    poll.stop();
  });

  it("stops without another call or a callback after stop()", async () => {
    const { call, next } = script();
    const onEvents = vi.fn();
    const poll = startPoll({ after: 0n, call, onEvents });
    const first = await next();
    poll.stop();
    first.resolve({ events: [event(1)], nextSeq: 1n });
    await Promise.resolve();
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("wakes from a back-off sleep when stopped", async () => {
    const { call, next } = script();
    let slept: AbortSignal | undefined;
    const poll = startPoll({
      after: 0n,
      call,
      onEvents: () => {},
      sleep: (_ms, signal) => {
        slept = signal;
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
      },
    });
    (await next()).reject(new Error("down"));
    await vi.waitFor(() => expect(slept).toBeDefined());
    poll.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
  });
});
