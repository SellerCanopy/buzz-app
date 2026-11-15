import { CheckCircleIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { Client } from "./engine/client";
import type { Inbox } from "./engine/useInbox";
import { GateCard } from "./GateCard";

/**
 * What waits for a person: approvals, agents' questions, and the runs that stopped for a
 * decision. Only the open items show, newest first; an answered item leaves the list and
 * its answer is in the card's Activity tab. The list is read by `useInbox` in the page, which
 * also counts it for the tab.
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
  const items = inbox.status === "ready" ? inbox.items : [];
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
      {items.length > 0 && (
        <ul className="beehive-inbox" aria-label="Needs you">
          {items.map((item) => (
            <li key={item.id}>
              <GateCard
                item={item}
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
