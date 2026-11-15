import type { Event } from "../gen/kiln/engine/v1/engine_pb";
import type { Client } from "./client";
import { POLL_WAIT_SECONDS, startPoll } from "./poll";

/** Someone who wants the events after a sequence number. */
export type Follower = {
  after: bigint;
  onEvents(events: Event[]): void;
  /** A failure of the shared poll. A `terminal` one ends it and every follower with it. */
  onError?(error: unknown, failures: number, terminal: boolean): void;
  onRecover?(): void;
};

/**
 * One long poll of the engine's event log, shared by everyone on one client who follows it.
 * The log has no filter, so each follower would otherwise park its own 25 second request and
 * download every event only to discard most of them.
 *
 * The poll starts with the first follower and stops with the last. A follower that arrives
 * from before the place the poll has reached restarts it from there, so no event after that
 * follower's own read is lost; a follower already following may then see an event twice, and
 * each applies events by reading its own state again, which makes that harmless. A terminal
 * failure (see `startPoll`) ends the poll and removes every follower after telling it, so
 * each must follow again, from a fresh read.
 */
export function createFeed(client: Pick<Client, "pollEvents">) {
  const followers = new Set<Follower>();
  let poll: { stop(): void } | undefined;
  let cursor: bigint | undefined;

  const stop = () => {
    poll?.stop();
    poll = undefined;
    cursor = undefined;
  };

  const begin = (after: bigint) => {
    poll?.stop();
    cursor = after;
    const mine = startPoll({
      after,
      call: async (at, signal) => {
        cursor = at;
        const next = await client.pollEvents(at, POLL_WAIT_SECONDS, signal);
        return { events: next.events, nextSeq: next.nextSeq };
      },
      onEvents: (events) => {
        for (const follower of [...followers]) follower.onEvents(events);
      },
      onError: (error, failures, terminal) => {
        const told = [...followers];
        if (terminal) {
          if (poll === mine) stop();
          followers.clear();
        }
        for (const follower of told)
          follower.onError?.(error, failures, terminal);
      },
      onRecover: () => {
        for (const follower of [...followers]) follower.onRecover?.();
      },
    });
    poll = mine;
  };

  return {
    /** Start following. Returns what stops it. */
    follow(follower: Follower): () => void {
      followers.add(follower);
      if (!poll || (cursor !== undefined && follower.after < cursor))
        begin(follower.after);
      return () => {
        followers.delete(follower);
        if (followers.size === 0) stop();
      };
    },
  };
}

export type Feed = ReturnType<typeof createFeed>;

const feeds = new WeakMap<object, Feed>();

/** The shared feed of `client`'s event log. */
export function feedOf(client: Pick<Client, "pollEvents">): Feed {
  let feed = feeds.get(client);
  if (!feed) {
    feed = createFeed(client);
    feeds.set(client, feed);
  }
  return feed;
}
