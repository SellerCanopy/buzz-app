import { useCallback, useEffect, useRef, useState } from "react";
import { clone, create } from "@bufbuild/protobuf";
import {
  CardSchema,
  type Card,
  type Event,
  type Run,
  type Workflow,
} from "../gen/kiln/engine/v1/engine_pb";
import type { Client } from "./client";
import { POLL_WAIT_SECONDS, pollErrorHandler, startPoll } from "./poll";
import { errorMessage } from "./transport";

export type Live =
  | { status: "loading" }
  /**
   * `cards` are the board and `archived` the archive. `paused` says why they stopped following
   * the event log, and `stale` that the last Refresh failed, so the lists shown may be stale.
   * `runs` and `workflows` fill the tiles in and stay unset when their read failed, which
   * leaves the board without progress rather than without cards.
   */
  | {
      status: "ready";
      cards: Card[];
      archived: Card[];
      runs?: Run[];
      workflows?: Workflow[];
      paused?: string;
      stale?: string;
    }
  | { status: "error"; message: string };

type Payload = { title?: unknown; workflow?: unknown; state?: unknown };

function payloadOf(event: Event): Payload {
  try {
    const value: unknown = JSON.parse(event.payloadJson || "{}");
    return value !== null && typeof value === "object"
      ? (value as Payload)
      : {};
  } catch {
    return {};
  }
}

const text = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

type Fields = Partial<Pick<Card, "title" | "workflow" | "state" | "archived">>;

/** A copy of `card` with some fields replaced. */
function withFields(card: Card, fields: Fields): Card {
  return Object.assign(clone(CardSchema, card), fields);
}

/**
 * Apply events to the cards of one view, the board (`archived` false) or the
 * archive. Every step is idempotent: the first events after a read can describe
 * changes the read already showed, so applying one twice leaves the same list.
 */
export function applyEvents(
  cards: Card[],
  events: Event[],
  archived: boolean,
): Card[] {
  let next = cards;
  const upsert = (id: string, payload: Payload, isArchived: boolean) => {
    if (isArchived !== archived) {
      next = next.filter((card) => card.id !== id);
      return;
    }
    const found = next.find((card) => card.id === id);
    const card = withFields(found ?? create(CardSchema, { id }), {
      title: text(payload.title, found?.title ?? ""),
      workflow: text(payload.workflow, found?.workflow ?? ""),
      state: text(payload.state, found?.state ?? "idle"),
      archived: isArchived,
    });
    next = found
      ? next.map((item) => (item.id === id ? card : item))
      : [card, ...next];
  };
  const change = (id: string, fields: Fields) => {
    next = next.map((card) =>
      card.id === id ? withFields(card, fields) : card,
    );
  };
  for (const event of events) {
    const id = event.cardId;
    if (!id) continue;
    const payload = payloadOf(event);
    switch (event.type) {
      case "card.created":
      case "card.restored":
        upsert(id, payload, false);
        break;
      case "card.archived":
        upsert(id, payload, true);
        break;
      case "card.removed":
        next = next.filter((card) => card.id !== id);
        break;
      case "card.moved":
        change(id, { workflow: text(payload.workflow, "") });
        break;
      case "card.state":
        change(id, { state: text(payload.state, "idle") });
        break;
    }
  }
  return next;
}

/** Whether an event changes a run or its stages, so the runs on the tiles are read again. */
export function touchesRuns(events: Event[]): boolean {
  return events.some(
    (event) =>
      /^(run|stage|result|round)\./.test(event.type) ||
      event.type === "card.skipped" ||
      event.type === "condition.unmet",
  );
}

/** Runs `task`; a call made while one runs collapses with others into one more run after it. */
function collapsed(task: () => Promise<void>): () => Promise<void> {
  let running = false;
  let again = false;
  return async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await task();
      } while (again);
    } finally {
      running = false;
    }
  };
}

/**
 * What the board shows, kept current: the cards of the board and of the archive, the runs that
 * fill the tiles in, and the workflows that name their stages. It reads each list once, then
 * follows the event log from the lowest sequence number those reads returned. The runs are read
 * again when an event goes by that changes one. `refresh` reads everything again in place, and
 * `retry` starts over after a failure, or when updates have paused.
 *
 * A mount costs four reads and one long poll. The runs and the workflows are only decoration, so
 * a failure of either leaves the cards on screen.
 */
export function useLive(client: Client) {
  const [live, setLive] = useState<Live>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const reader = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => reader.current(), []);

  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    const { signal } = abort;
    let poll: { stop(): void } | undefined;
    setLive({ status: "loading" });

    const readAll = async () => {
      const [open, archived, runs, workflows] = await Promise.all([
        client.listCards(false, signal),
        client.listCards(true, signal),
        client.listRuns("", signal).catch(() => undefined),
        client.listWorkflows(signal).catch(() => undefined),
      ]);
      const seqs = [open.seq, archived.seq, ...(runs ? [runs.seq] : [])];
      return {
        cards: open.cards,
        archived: archived.cards,
        runs: runs?.runs,
        workflows: workflows?.workflows,
        after: seqs.reduce((low, seq) => (seq < low ? seq : low)),
      };
    };

    const readRuns = collapsed(async () => {
      try {
        const reply = await client.listRuns("", signal);
        if (signal.aborted) return;
        setLive((current) =>
          current.status === "ready"
            ? { ...current, runs: reply.runs }
            : current,
        );
      } catch {
        // The runs on screen stay; the next run event reads them again.
      }
    });

    reader.current = () =>
      void collapsed(async () => {
        try {
          const next = await readAll();
          if (signal.aborted) return;
          setLive((current) => {
            if (current.status !== "ready") return current;
            const runs = next.runs ?? current.runs;
            const workflows = next.workflows ?? current.workflows;
            return {
              status: "ready",
              cards: next.cards,
              archived: next.archived,
              ...(runs ? { runs } : {}),
              ...(workflows ? { workflows } : {}),
              ...(current.paused ? { paused: current.paused } : {}),
            };
          });
        } catch (error) {
          if (signal.aborted) return;
          // A board already on screen stays, with the failure said beside it.
          setLive((current) =>
            current.status === "ready"
              ? { ...current, stale: errorMessage(error) }
              : current,
          );
        }
      })();

    readAll()
      .then(({ after, cards, archived, runs, workflows }) => {
        if (signal.aborted) return;
        setLive({
          status: "ready",
          cards,
          archived,
          ...(runs ? { runs } : {}),
          ...(workflows ? { workflows } : {}),
        });
        poll = startPoll({
          after,
          call: async (at, pollSignal) => {
            const next = await client.pollEvents(
              at,
              POLL_WAIT_SECONDS,
              pollSignal,
            );
            return { events: next.events, nextSeq: next.nextSeq };
          },
          onEvents: (events) => {
            setLive((current) =>
              current.status === "ready"
                ? {
                    ...current,
                    cards: applyEvents(current.cards, events, false),
                    archived: applyEvents(current.archived, events, true),
                  }
                : current,
            );
            if (touchesRuns(events)) void readRuns();
          },
          onError: pollErrorHandler("Beehive live updates failed", (paused) =>
            setLive((current) =>
              current.status === "ready" ? { ...current, paused } : current,
            ),
          ),
          onRecover: () =>
            setLive((current) => {
              if (current.status !== "ready" || !current.paused) return current;
              const { paused: _paused, ...rest } = current;
              return rest;
            }),
        });
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        setLive({ status: "error", message: errorMessage(error) });
      });
    return () => {
      abort.abort();
      poll?.stop();
      reader.current = () => undefined;
    };
  }, [client, attempt]);

  return { live, retry, refresh };
}
