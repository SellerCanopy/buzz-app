import { describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { EventSchema } from "../gen/kiln/engine/v1/engine_pb";
import { startPoll } from "./poll";
import { EngineError } from "./transport";

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

  it("stops without another call or a callback after stop(), even if the call ignores the abort", async () => {
    // A call that does not listen to the signal still resolves after stop().
    const late: { resolve(): void }[] = [];
    const call = vi.fn(
      () =>
        new Promise<{ events: ReturnType<typeof event>[]; nextSeq: bigint }>(
          (resolve) =>
            late.push({
              resolve: () => resolve({ events: [event(1)], nextSeq: 1n }),
            }),
        ),
    );
    const onEvents = vi.fn();
    const onRecover = vi.fn();
    const poll = startPoll({ after: 0n, call, onEvents, onRecover });
    await vi.waitFor(() => expect(late).toHaveLength(1));
    poll.stop();
    late[0]?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(call).toHaveBeenCalledTimes(1);
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("reports each failure with its count and keeps going when retrying can help", async () => {
    const { call, next } = script();
    const onError = vi.fn();
    const poll = startPoll({
      after: 0n,
      call,
      onEvents: () => {},
      onError,
      sleep: async () => {},
    });
    const down = new EngineError("unavailable", "down", 503);
    (await next()).reject(down);
    (await next()).reject(down);
    await next();
    expect(onError).toHaveBeenNthCalledWith(1, down, 1, false);
    expect(onError).toHaveBeenNthCalledWith(2, down, 2, false);
    poll.stop();
  });

  it("stops and says terminal for a failure retrying cannot cure", async () => {
    for (const code of [
      "unauthenticated",
      "permission_denied",
      "invalid_argument",
      "failed_precondition",
      "out_of_range",
    ]) {
      const { call, next } = script();
      const onError = vi.fn();
      const sleep = vi.fn(async () => {});
      startPoll({ after: 0n, call, onEvents: () => {}, onError, sleep });
      const refused = new EngineError(code, "no", 400);
      (await next()).reject(refused);
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(refused, 1, true),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(call).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("calls onRecover on the first success after failures and not before", async () => {
    const { call, next } = script();
    const onRecover = vi.fn();
    const poll = startPoll({
      after: 0n,
      call,
      onEvents: () => {},
      onRecover,
      sleep: async () => {},
    });
    (await next()).resolve({ events: [], nextSeq: 0n });
    (await next()).reject(new Error("down"));
    (await next()).reject(new Error("down"));
    expect(onRecover).not.toHaveBeenCalled();
    (await next()).resolve({ events: [], nextSeq: 0n });
    // The call after the success is up, so the success has been handled.
    const following = await next();
    expect(onRecover).toHaveBeenCalledTimes(1);
    following.resolve({ events: [], nextSeq: 0n });
    await next();
    expect(onRecover).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("does not fetch the same events again when onEvents throws, and reports it as terminal", async () => {
    const { call, next } = script();
    const boom = new Error("cannot apply");
    const onEvents = vi.fn(() => {
      throw boom;
    });
    const onError = vi.fn();
    startPoll({ after: 0n, call, onEvents, onError, sleep: async () => {} });
    (await next()).resolve({ events: [event(1)], nextSeq: 1n });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(boom, 1, true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(call).toHaveBeenCalledTimes(1);
    expect(onEvents).toHaveBeenCalledTimes(1);
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
