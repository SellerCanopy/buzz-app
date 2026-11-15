import type { Event } from "../gen/kiln/engine/v1/engine_pb";
import { EngineError, errorMessage } from "./transport";

/** One long poll takes at most this long on the engine, which clamps the wait to 25 s. */
export const POLL_WAIT_SECONDS = 25;
const BASE_MS = 500;
const CAP_MS = 30_000;
/** Tell the person after this many failures in a row, not at the first blip. */
const PAUSE_AFTER = 3;
/** Log the first failure and then every this many, so a long outage is one line per few minutes. */
const LOG_EVERY = 10;

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

/** Failures that retrying cannot cure: a refused caller, or a cursor the engine does not hold. */
const TERMINAL = new Set([
  "unauthenticated",
  "permission_denied",
  "invalid_argument",
  "failed_precondition",
  "out_of_range",
]);

function isTerminal(error: unknown): boolean {
  return error instanceof EngineError && TERMINAL.has(error.code);
}

/**
 * Follow the event log from `after`. Each call parks on the engine until there is
 * something new, so a quiet board costs one request every 25 seconds. After a
 * failure it waits a random time up to a capped, growing ceiling (full jitter),
 * because every open board retries together when the engine restarts, and then
 * resumes from the last cursor it saw rather than from the start.
 *
 * Every failure goes to `onError` with the count so far. A failure that retrying
 * cannot cure (see `TERMINAL`), or events that `onEvents` cannot apply, stops the
 * loop and reports `terminal`, so the caller shows it and reads the list again
 * instead of leaving a frozen board. `onRecover` runs on the first success after
 * failures.
 */
export function startPoll(opts: {
  after: bigint;
  call: (
    afterSeq: bigint,
    signal: AbortSignal,
  ) => Promise<{ events: Event[]; nextSeq: bigint }>;
  onEvents: (events: Event[]) => void;
  onError?: (error: unknown, failures: number, terminal: boolean) => void;
  onRecover?: () => void;
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
      let reply: { events: Event[]; nextSeq: bigint };
      try {
        reply = await opts.call(cursor, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        failures += 1;
        const terminal = isTerminal(error);
        opts.onError?.(error, failures, terminal);
        if (terminal) return;
        const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** Math.min(failures, 6));
        await sleep(random() * ceiling, controller.signal);
        continue;
      }
      if (controller.signal.aborted) return;
      if (failures > 0) opts.onRecover?.();
      failures = 0;
      // Applying events is not a network failure: do not fetch the same batch again.
      try {
        if (reply.events.length) opts.onEvents(reply.events);
      } catch (error) {
        opts.onError?.(error, 1, true);
        return;
      }
      cursor = reply.nextSeq;
    }
  })();
  return { stop: () => controller.abort() };
}

/**
 * The `onError` of a view that follows the log: it logs the first failure and then one in
 * `LOG_EVERY`, and calls `onPause` with a sentence for the person once failures stop being a
 * blip (`PAUSE_AFTER` in a row) or cannot be cured by retrying.
 */
export function pollErrorHandler(
  label: string,
  onPause: (message: string) => void,
): (error: unknown, failures: number, terminal: boolean) => void {
  return (error, failures, terminal) => {
    if (failures === 1 || failures % LOG_EVERY === 0)
      console.warn(label, {
        code: error instanceof EngineError ? error.code : undefined,
        status: error instanceof EngineError ? error.status : undefined,
        failures,
        terminal,
      });
    if (terminal || failures >= PAUSE_AFTER)
      onPause(`Live updates paused: ${errorMessage(error)}`);
  };
}
