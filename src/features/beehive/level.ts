import type { Event } from "./gen/kiln/engine/v1/engine_pb";
import type { Client } from "./engine/client";
import { feedOf } from "./engine/feed";
import { EngineError, errorMessage } from "./engine/transport";

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

/** What each level is called. */
export const LABELS: Record<Level, string> = {
  none: "None",
  read: "Read",
  run: "Run",
  admin: "Admin",
};

/** What each level lets a person do. */
export const MEANING: Record<Level, string> = {
  none: "Cannot open Beehive",
  read: "Can look, cannot change",
  run: "Can add cards and run stages",
  admin: "Can also set levels and settings",
};

/** The part of an access entry that decides what its level may become. */
export type Assignee = {
  pubkey: string;
  kind: string;
  level: Level;
  /** The level of the owner when the entry is an agent. */
  ownerLevel: Level;
};

/**
 * Whether an entry may be set to `choice`. An agent never acts above its owner, and an admin
 * cannot lower themselves. This only mirrors the engine's rules so the options that would be
 * refused are unavailable; the engine's answer stays the authority. The level an entry already
 * holds is always allowed, so the control can show it.
 */
export function assignable(
  entry: Assignee,
  me: string,
  choice: Level,
): { allowed: boolean; reason?: string } {
  if (choice === entry.level) return { allowed: true };
  if (entry.kind === "agent" && !atLeast(entry.ownerLevel, choice))
    return {
      allowed: false,
      reason: `Above its owner's level (${LABELS[entry.ownerLevel]})`,
    };
  if (entry.pubkey === me && choice !== "admin")
    return { allowed: false, reason: "You cannot lower your own level" };
  return { allowed: true };
}

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
/** After a read fails, the first try again waits about this long, and each one after doubles it. */
const RETRY_BASE_MS = 5_000;
/** A failed read is never tried again later than about this. */
const RETRY_CAP_MS = 120_000;

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

/** Whether the engine turned the caller away, as opposed to failing to answer. */
function refused(error: unknown): boolean {
  return (
    error instanceof EngineError &&
    (error.code === "unauthenticated" || error.code === "permission_denied")
  );
}

/**
 * The signed-in person's level, kept current.
 *
 * It reads `WhoAmI`, and from Read up follows the event log for an `access.changed` event
 * that names the person, which reads it again. The log is followed through the client's shared
 * feed, taken from a cursor read before the level so a change in between is replayed rather
 * than missed. A person at None cannot read events, so the level is read again on a long
 * backstop, and the backstop also repairs a missed event. A relay role changing, such as being
 * removed from the community, raises no such event: the next call fails as refused. A poll
 * the engine refuses reads the level again once, and follows again only if the level changed
 * or the backstop fires, so a persistent refusal costs one read per backstop, not a loop.
 *
 * A read the engine refuses outright takes the level to None, and one that fails for any other
 * reason keeps the level held and tries again on a capped, jittered backoff.
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
  let retry: () => void = () => undefined;

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
    refresh: () => retry(),
    start(): () => void {
      const abort = new AbortController();
      let unfollow: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reading = false;
      let again = false;
      let failures = 0;
      /** The level at which the engine refused the poll: not followed again at that level. */
      let refusedAt: Level | undefined;

      const stopPoll = () => {
        unfollow?.();
        unfollow = undefined;
      };

      const follow = (pubkey: string, after: bigint) => {
        unfollow = feedOf(client).follow({
          after,
          onEvents: (events) => {
            if (changesLevelOf(events, pubkey)) reread();
          },
          // A refused poll means the level is no longer what it was. Read it again once.
          onError: (_error, _failures, terminal) => {
            if (!terminal) return;
            stopPoll();
            refusedAt = state.status === "ready" ? state.level : undefined;
            reread();
          },
        });
      };

      /** The newest event's number, or none when the engine would not say. */
      const headSeq = async () => {
        try {
          return (await client.getStatus(abort.signal)).headSeq;
        } catch {
          return undefined;
        }
      };

      const read = async () => {
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        let failed = false;
        try {
          do {
            again = false;
            // Take the cursor before the level it guards, so a change made between the two
            // reads is replayed. Skip it when nothing will follow: already following, a poll
            // the engine refused, or a person known to be at None, who cannot read events.
            const early =
              unfollow ||
              refusedAt !== undefined ||
              (state.status === "ready" && state.level === "none")
                ? undefined
                : await headSeq();
            if (abort.signal.aborted) return;
            let me: Awaited<ReturnType<typeof client.whoAmI>>;
            try {
              me = await client.whoAmI(abort.signal);
            } catch (error) {
              if (abort.signal.aborted) return;
              if (!refused(error)) throw error;
              // The engine turned the caller away: the level held no longer stands.
              stopPoll();
              set(
                state.status === "ready"
                  ? { status: "ready", level: "none", pubkey: state.pubkey }
                  : { status: "error", message: errorMessage(error) },
              );
              continue;
            }
            if (abort.signal.aborted) return;
            const level = parseLevel(me.role);
            const pubkey = me.me?.userId ?? "";
            set({ status: "ready", level, pubkey });
            if (refusedAt !== level) refusedAt = undefined;
            if (!atLeast(level, "read")) stopPoll();
            else if (!unfollow && refusedAt === undefined) {
              const after =
                early ?? (await client.getStatus(abort.signal)).headSeq;
              if (abort.signal.aborted) return;
              if (!unfollow) follow(pubkey, after);
            }
          } while (again && !abort.signal.aborted);
        } catch (error) {
          if (abort.signal.aborted) return;
          failed = true;
          // A level already known stands while the read is tried again.
          if (state.status !== "ready")
            set({ status: "error", message: errorMessage(error) });
        } finally {
          reading = false;
          failures = failed ? failures + 1 : 0;
          if (!abort.signal.aborted) {
            clearTimeout(timer);
            const wait = failed
              ? Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (failures - 1)) *
                (0.5 + random() / 2)
              : BACKSTOP_MS * (1 + (random() * 2 - 1) * JITTER);
            timer = setTimeout(() => {
              refusedAt = undefined;
              void read();
            }, wait);
          }
        }
      };

      reread = () => void read();
      retry = () => {
        refusedAt = undefined;
        void read();
      };
      void read();
      return () => {
        abort.abort();
        stopPoll();
        clearTimeout(timer);
        reread = () => undefined;
        retry = () => undefined;
      };
    },
  };
}

export type LevelStore = ReturnType<typeof createLevelStore>;
