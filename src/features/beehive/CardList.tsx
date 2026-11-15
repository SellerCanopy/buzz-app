import { HexagonIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import type { Card } from "./gen/kiln/engine/v1/engine_pb";
import type { Client } from "./engine/client";
import { useLive } from "./engine/useLive";
import { stateLabel } from "./labels";

/** Board columns by where a card is: Backlog has no workflow, the rest follow its state. */
const COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "To do" },
  { key: "running", label: "Running" },
  { key: "waiting", label: "Waiting" },
  { key: "attention", label: "Needs attention" },
  { key: "done", label: "Done" },
] as const;

export function columnOf(card: Card): (typeof COLUMNS)[number]["key"] {
  if (!card.workflow) return "backlog";
  switch (card.state) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
    case "stopped":
      return "attention";
    case "done":
      return "done";
    default:
      return "todo";
  }
}

/**
 * The board of live cards, or the archive. It owns the read and the event log, so
 * they run only while one of the two is showing. A card opens on its own page.
 */
export function CardList({
  client,
  archived,
  canRun,
  onOpen,
  onNew,
}: {
  client: Client;
  archived: boolean;
  canRun: boolean;
  onOpen(card: string): void;
  onNew(): void;
}) {
  const { live, retry } = useLive(client, archived);
  const failed = live.status === "error";
  const paused = live.status === "ready" ? live.paused : undefined;
  const cards = live.status === "ready" ? live.cards : [];
  const problem = failed ? live.message : paused;
  return (
    <LoadingRegion
      pending={live.status === "loading"}
      label="Loading cards…"
      feedback={
        problem ? (
          <div className="beehive-error">
            <p role="alert" className="text-danger">
              {problem}
            </p>
            <Button onClick={retry}>Retry</Button>
          </div>
        ) : undefined
      }
    >
      {live.status === "ready" && cards.length === 0 && (
        <EmptyState
          icon={<HexagonIcon size="1.5rem" />}
          title={archived ? "Nothing archived" : "No cards yet"}
          description={
            archived
              ? "Cards you archive are kept here and can be restored."
              : "Cards you add will show up here."
          }
          action={
            !archived && canRun ? (
              <Button
                variant="prominent"
                onClick={onNew}
                title="Add a card to the board"
              >
                New card
              </Button>
            ) : undefined
          }
        />
      )}
      {live.status === "ready" && cards.length > 0 && !archived && (
        <div className="beehive-columns">
          {COLUMNS.map((column) => {
            const inColumn = cards.filter((c) => columnOf(c) === column.key);
            return (
              <section
                key={column.key}
                aria-label={column.label}
                className="beehive-column"
              >
                <InlineHeader title={column.label} />
                <ul className="beehive-cards">
                  {inColumn.map((card) => (
                    <CardRow key={card.id} card={card} onOpen={onOpen} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {live.status === "ready" && cards.length > 0 && archived && (
        <ul className="beehive-cards" aria-label="Archived cards">
          {cards.map((card) => (
            <CardRow key={card.id} card={card} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </LoadingRegion>
  );
}

function CardRow({ card, onOpen }: { card: Card; onOpen(card: string): void }) {
  return (
    <li>
      <NavigationItem
        multiline
        label={card.title}
        trailing={
          <span className="text-body-sm text-subtle">{stateLabel(card)}</span>
        }
        onClick={() => onOpen(card.id)}
      />
    </li>
  );
}
