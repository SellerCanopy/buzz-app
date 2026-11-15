import { useCallback, useEffect, useRef, useState } from "react";
import type { Event, InboxItem } from "../gen/kiln/engine/v1/engine_pb";
import type { Client } from "./client";
import { feedOf } from "./feed";
import { pollErrorHandler } from "./poll";
import { errorMessage } from "./transport";

export type Inbox =
  | { status: "loading" }
  /**
   * `paused` says why the list stopped following the event log, and `stale` that the last
   * read failed, so in both cases the list may be out of date.
   */
  | { status: "ready"; items: InboxItem[]; paused?: string; stale?: string }
  | { status: "error"; message: string };

/** Whether an event changes what waits for a person. */
export function touchesInbox(events: Event[]): boolean {
  return events.some((event) => event.type.startsWith("inbox."));
}

/**
 * The items that wait for a person, kept current. It reads the list once, follows the event
 * log from the sequence number that read returned, and reads the list again when an
 * `inbox.opened` or `inbox.resolved` event goes by. The list holds only the open items, so
 * the read stays small however many were answered. `refresh` reads again at once, as after
 * an answer, and `retry` starts over after a failure.
 */
export function useInbox(client: Client) {
  const [inbox, setInbox] = useState<Inbox>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const reader = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => reader.current(), []);

  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    let unfollow: (() => void) | undefined;
    let reading = false;
    let again = false;
    setInbox({ status: "loading" });

    /** Reads the list. Reads asked for while one runs collapse into one more read after it. */
    const read = async (first: boolean) => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          const reply = await client.listInbox(abort.signal);
          if (abort.signal.aborted) return;
          setInbox((current) => ({
            status: "ready",
            items: reply.items,
            ...(current.status === "ready" && current.paused
              ? { paused: current.paused }
              : {}),
          }));
          if (first && !unfollow) unfollow = follow(reply.seq);
        } while (again);
      } catch (error) {
        if (abort.signal.aborted) return;
        // A list already on screen stays, with the failure said beside it.
        setInbox((current) =>
          current.status === "ready"
            ? { ...current, stale: errorMessage(error) }
            : { status: "error", message: errorMessage(error) },
        );
      } finally {
        reading = false;
      }
    };
    reader.current = () => void read(false);

    const follow = (after: bigint) =>
      feedOf(client).follow({
        after,
        onEvents: (events) => {
          if (touchesInbox(events)) void read(false);
        },
        onError: pollErrorHandler("Beehive inbox updates failed", (paused) =>
          setInbox((current) =>
            current.status === "ready" ? { ...current, paused } : current,
          ),
        ),
        onRecover: () =>
          setInbox((current) =>
            current.status === "ready" && current.paused
              ? {
                  status: "ready",
                  items: current.items,
                  ...(current.stale ? { stale: current.stale } : {}),
                }
              : current,
          ),
      });

    void read(true);
    return () => {
      abort.abort();
      unfollow?.();
      reader.current = () => undefined;
    };
  }, [client, attempt]);

  return { inbox, retry, refresh };
}
