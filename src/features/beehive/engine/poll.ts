import type { Event } from "../gen/kiln/engine/v1/engine_pb";

/** One long poll takes at most this long on the engine, which clamps the wait to 25 s. */
export const POLL_WAIT_SECONDS = 25;
const BASE_MS = 500;
const CAP_MS = 30_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * Follow the event log from `after`. Each call parks on the engine until there is
 * something new, so a quiet board costs one request every 25 seconds. After a
 * failure it waits a random time up to a capped, growing ceiling (full jitter),
 * because every open board retries together when the engine restarts, and then
 * resumes from the last cursor it saw rather than from the start.
 */
export function startPoll(opts: {
  after: bigint;
  call: (
    afterSeq: bigint,
    signal: AbortSignal,
  ) => Promise<{ events: Event[]; nextSeq: bigint }>;
  onEvents: (events: Event[]) => void;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): { stop(): void } {
  const controller = new AbortController();
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  let cursor = opts.after;
  let failures = 0;
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const reply = await opts.call(cursor, controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        if (reply.events.length) opts.onEvents(reply.events);
        cursor = reply.nextSeq;
      } catch {
        if (controller.signal.aborted) return;
        failures += 1;
        const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** Math.min(failures, 6));
        await sleep(random() * ceiling, controller.signal);
      }
    }
  })();
  return { stop: () => controller.abort() };
}
