import { useCallback, useEffect, useState } from "react";
import { clone, create } from "@bufbuild/protobuf";
import {
  CardSchema,
  type Card,
  type Event,
} from "../gen/kiln/engine/v1/engine_pb";
import type { Client } from "./client";
import { POLL_WAIT_SECONDS, startPoll } from "./poll";

export type Live =
  | { status: "loading" }
  | { status: "ready"; cards: Card[] }
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

/**
 * The cards of the board or the archive, kept current. It reads the list once,
 * then follows the event log from the sequence number that read returned.
 * `retry` runs the read again after a failure.
 */
export function useLive(client: Client, archived: boolean) {
  const [live, setLive] = useState<Live>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    let poll: { stop(): void } | undefined;
    setLive({ status: "loading" });
    client
      .listCards(archived, abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        setLive({ status: "ready", cards: reply.cards });
        poll = startPoll({
          after: reply.seq,
          call: async (after, signal) => {
            const next = await client.pollEvents(
              after,
              POLL_WAIT_SECONDS,
              signal,
            );
            return { events: next.events, nextSeq: next.nextSeq };
          },
          onEvents: (events) =>
            setLive((current) =>
              current.status === "ready"
                ? {
                    status: "ready",
                    cards: applyEvents(current.cards, events, archived),
                  }
                : current,
            ),
        });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setLive({
          status: "error",
          message:
            error instanceof Error ? error.message : "Beehive did not answer",
        });
      });
    return () => {
      abort.abort();
      poll?.stop();
    };
  }, [client, archived, attempt]);

  return { live, retry };
}
