import { useState } from "react";
import { HexagonIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type { Card } from "./gen/kiln/engine/v1/engine_pb";
import type { Client } from "./engine/client";
import { useLive } from "./engine/useLive";
import { stateLabel } from "./labels";
import type { RelayData } from "../relay/service";
import { SettingsPage } from "./SettingsPage";
import { WorkflowsPage } from "./WorkflowsPage";

type View = "board" | "archive" | "workflows" | "settings";

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

/** The board of live cards, the archive, or the workflows list. A card opens on its own page. */
export function BoardPage({
  client,
  relay,
  canRun,
  isAdmin,
  onOpen,
  onNew,
}: {
  client: Client;
  relay: RelayData;
  canRun: boolean;
  isAdmin: boolean;
  onOpen(card: string): void;
  onNew(): void;
}) {
  const [view, setView] = useState<View>("board");
  const { live, retry } = useLive(client, view === "archive");
  const failed = live.status === "error";
  const cards = live.status === "ready" ? live.cards : [];
  const toolbar = (
    <div className="beehive-toolbar">
      <Tabs
        variant="segmented"
        size="sm"
        label="View"
        value={view}
        onValueChange={setView}
        items={[
          { value: "board", label: "Board" },
          { value: "archive", label: "Archive" },
          { value: "workflows", label: "Workflows" },
          { value: "settings", label: "Settings" },
        ]}
      />
    </div>
  );
  if (view === "workflows")
    return (
      <>
        {toolbar}
        <WorkflowsPage client={client} />
      </>
    );
  if (view === "settings")
    return (
      <>
        {toolbar}
        <SettingsPage client={client} relay={relay} isAdmin={isAdmin} />
      </>
    );
  return (
    <>
      {toolbar}
      <LoadingRegion
        pending={live.status === "loading"}
        label="Loading cards…"
        feedback={
          failed ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {live.message}
              </p>
              <Button onClick={retry}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {live.status === "ready" && cards.length === 0 && (
          <EmptyState
            icon={<HexagonIcon size="1.5rem" />}
            title={view === "board" ? "No cards yet" : "Nothing archived"}
            description={
              view === "board"
                ? "Cards you add will show up here."
                : "Cards you archive are kept here and can be restored."
            }
            action={
              view === "board" && canRun ? (
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
        {live.status === "ready" && cards.length > 0 && view === "board" && (
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
        {live.status === "ready" && cards.length > 0 && view === "archive" && (
          <ul className="beehive-cards" aria-label="Archived cards">
            {cards.map((card) => (
              <CardRow key={card.id} card={card} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </LoadingRegion>
    </>
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
