import type { Event } from "./gen/kiln/engine/v1/engine_pb";
import type { Client } from "./engine/client";
import { POLL_WAIT_SECONDS, startPoll } from "./engine/poll";
import { errorMessage } from "./engine/transport";

/** What a person may do in Beehive. Each level includes the ones before it. */
export type Level = "none" | "read" | "run" | "admin";

export const LEVELS: readonly Level[] = ["none", "read", "run", "admin"];

/** The level the engine named. A word this app does not know gives nothing, never more. */
export function parseLevel(role: string): Level {
  return LEVELS.find((level) => level === role) ?? "none";
}

/** Whether `level` is at least `needed`. */
export function atLeast(level: Level, needed: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(needed);
}

export type LevelState =
  | { status: "loading" }
  | { status: "ready"; level: Level; pubkey: string }
  | { status: "error"; message: string };

/**
 * Whether the dock shows Beehive. A person at None has no dock entry. While the engine has
 * not answered there is none either, so a person at None never sees it flash. When the answer
 * cannot be read the entry stays, so the page can say so and offer to ask again.
 */
export function showsDock(state: LevelState): boolean {
  return (
    state.status === "error" ||
    (state.status === "ready" && state.level !== "none")
  );
}

/** Read the level again this long after the last read when nothing else prompted one. */
export const BACKSTOP_MS = 10 * 60_000;
/** The backstop moves by up to this share either way, so clients that started together drift apart. */
const JITTER = 0.2;

/** Whether an event changes the level of `pubkey`. */
export function changesLevelOf(events: Event[], pubkey: string): boolean {
  return events.some((event) => {
    if (event.type !== "access.changed") return false;
    try {
      const payload: unknown = JSON.parse(event.payloadJson);
      return (
        typeof payload === "object" &&
        payload !== null &&
        "pubkey" in payload &&
        payload.pubkey === pubkey
      );
    } catch {
      return false;
    }
  });
}

/**
 * The signed-in person's level, kept current.
 *
 * It reads `WhoAmI`, and from Read up follows the event log for an `access.changed` event
 * that names the person, which reads it again. A person at None cannot read events, so the
 * level is read again on a long backstop, and the backstop also repairs a missed event. A
 * relay role changing, such as being removed from the community, raises no such event: the
 * next call fails as refused, which reads the level again.
 *
 * `start` begins reading and returns what stops it, so the host owns the lifetime.
 */
export function createLevelStore(
  client: Pick<Client, "whoAmI" | "getStatus" | "pollEvents">,
  random: () => number = Math.random,
) {
  let state: LevelState = { status: "loading" };
  const listeners = new Set<() => void>();
  let reread: () => void = () => undefined;

  const set = (next: LevelState) => {
    if (
      next.status === state.status &&
      (next.status !== "ready" ||
        (state.status === "ready" &&
          next.level === state.level &&
          next.pubkey === state.pubkey)) &&
      (next.status !== "error" ||
        (state.status === "error" && next.message === state.message))
    )
      return;
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Read again now, as after a failure the person asked to retry. */
    refresh: () => reread(),
    start(): () => void {
      const abort = new AbortController();
      let poll: { stop(): void } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reading = false;
      let again = false;

      const stopPoll = () => {
        poll?.stop();
        poll = undefined;
      };

      const follow = async (pubkey: string) => {
        if (poll) return;
        const status = await client.getStatus(abort.signal);
        if (abort.signal.aborted || poll) return;
        poll = startPoll({
          after: status.headSeq,
          call: async (cursor, signal) => {
            const next = await client.pollEvents(
              cursor,
              POLL_WAIT_SECONDS,
              signal,
            );
            return { events: next.events, nextSeq: next.nextSeq };
          },
          onEvents: (events) => {
            if (changesLevelOf(events, pubkey)) reread();
          },
          // A refused poll means the level is no longer what it was. Read it again.
          onError: (_error, _failures, terminal) => {
            if (!terminal) return;
            stopPoll();
            reread();
          },
        });
      };

      const read = async () => {
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        try {
          do {
            again = false;
            const me = await client.whoAmI(abort.signal);
            if (abort.signal.aborted) return;
            const level = parseLevel(me.role);
            const pubkey = me.me?.userId ?? "";
            set({ status: "ready", level, pubkey });
            if (!atLeast(level, "read")) stopPoll();
            else await follow(pubkey);
          } while (again && !abort.signal.aborted);
        } catch (error) {
          if (abort.signal.aborted) return;
          // A level already known stands: it is read again on the backstop.
          if (state.status !== "ready")
            set({ status: "error", message: errorMessage(error) });
        } finally {
          reading = false;
          if (!abort.signal.aborted) {
            clearTimeout(timer);
            timer = setTimeout(
              () => void read(),
              BACKSTOP_MS * (1 + (random() * 2 - 1) * JITTER),
            );
          }
        }
      };

      reread = () => void read();
      void read();
      return () => {
        abort.abort();
        stopPoll();
        clearTimeout(timer);
        reread = () => undefined;
      };
    },
  };
}

export type LevelStore = ReturnType<typeof createLevelStore>;
