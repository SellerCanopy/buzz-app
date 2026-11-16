import { useEffect, useRef, useState } from "react";
import { CheckCircleIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type { Client } from "./engine/client";
import type { Inbox } from "./engine/useInbox";
import type { InboxItem } from "./gen/kiln/engine/v1/engine_pb";
import { ALL } from "./boardModel";
import { GateCard } from "./GateCard";
import { INBOX_KIND_ORDER, inboxKindLabel } from "./labels";

/** When an item was opened, as nanoseconds; one with no time sorts first. */
function openedAt(item: InboxItem): bigint {
  const at = item.createdAt;
  return at ? at.seconds * 1_000_000_000n + BigInt(at.nanos) : 0n;
}

/**
 * The workflow of each card an item waits on, by card id. The list of items names the card by
 * title only, so the cards are read once when an item for a card not yet seen shows up, not on
 * every change. A card that cannot be read leaves its items without a workflow.
 */
function useWorkflows(client: Client, cardIds: string[]) {
  const [workflows, setWorkflows] = useState<Map<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  const key = cardIds.join("|");
  useEffect(() => {
    const fresh = key.split("|").filter((id) => id && !asked.current.has(id));
    if (fresh.length === 0) return;
    const abort = new AbortController();
    client
      .listCards(false, abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        for (const id of fresh) asked.current.add(id);
        setWorkflows(new Map(reply.cards.map((c) => [c.id, c.workflow])));
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [client, key]);
  return workflows;
}

/**
 * What waits for a person: approvals, agents' questions, and the runs that stopped for a
 * decision. Only the open items show, oldest first, as the page's subtitle says; an answered
 * item leaves the list and its answer is in the card's Activity tab. The list is read by
 * `useInbox` in the page, which also counts it for the sidebar.
 */
export function NeedsYouPage({
  client,
  inbox,
  canRun,
  onOpen,
  onAnswered,
  onRetry,
}: {
  client: Client;
  inbox: Inbox;
  canRun: boolean;
  onOpen(card: string): void;
  /** Called after an answer was accepted, so the list reads again at once. */
  onAnswered(): void;
  onRetry(): void;
}) {
  const [kind, setKind] = useState(ALL);
  // The engine sends the newest first. A sort is stable, so equal times keep its order.
  const waiting =
    inbox.status === "ready"
      ? [...inbox.items].sort((a, b) => {
          const [x, y] = [openedAt(a), openedAt(b)];
          return x < y ? -1 : x > y ? 1 : 0;
        })
      : [];
  const workflows = useWorkflows(
    client,
    waiting.map((item) => item.cardId),
  );
  // A kind that has run out of items falls back to All rather than showing an empty list.
  const shown = waiting.some((item) => item.kind === kind) ? kind : ALL;
  const items =
    shown === ALL ? waiting : waiting.filter((item) => item.kind === shown);
  // The kinds that wait, the engine's own first and any it adds after.
  const kinds = [
    ...new Set([...INBOX_KIND_ORDER, ...waiting.map((item) => item.kind)]),
  ].filter((value) => waiting.some((item) => item.kind === value));
  const problem =
    inbox.status === "error"
      ? inbox.message
      : inbox.status === "ready"
        ? (inbox.paused ?? inbox.stale)
        : undefined;
  return (
    <LoadingRegion
      pending={inbox.status === "loading"}
      label="Loading what needs you…"
      feedback={
        problem ? (
          <div className="beehive-error">
            <p role="alert" className="text-danger">
              {problem}
            </p>
            <Button onClick={onRetry}>Retry</Button>
          </div>
        ) : undefined
      }
    >
      {inbox.status === "ready" && items.length === 0 && (
        <EmptyState
          icon={<CheckCircleIcon size="1.5rem" />}
          title="Nothing needs you"
          description="Approvals, questions from agents and runs that wait for a decision show up here."
        />
      )}
      {waiting.length > 0 && (
        <Tabs
          variant="segmented"
          size="sm"
          label="Kind"
          value={shown}
          items={[
            { value: ALL, label: `All ${waiting.length}` },
            ...kinds.map((value) => ({
              value,
              label: `${inboxKindLabel(value)} ${waiting.filter((item) => item.kind === value).length}`,
            })),
          ]}
          onValueChange={setKind}
        />
      )}
      {items.length > 0 && (
        <ul className="beehive-inbox" aria-label="Needs you">
          {items.map((item) => (
            <li key={item.id}>
              <GateCard
                item={item}
                workflow={workflows.get(item.cardId) ?? ""}
                canRun={canRun}
                onOpenCard={onOpen}
                onAnswer={async (answered, choice, text) => {
                  await client.answerInbox(answered.id, choice, text);
                  onAnswered();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </LoadingRegion>
  );
}
