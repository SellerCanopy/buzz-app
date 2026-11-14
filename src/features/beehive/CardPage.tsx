import { useEffect, useState } from "react";
import { XIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type { Card } from "./gen/kiln/engine/v1/engine_pb";
import type { Client } from "./engine/client";
import { stateLabel } from "./labels";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; card: Card }
  | { status: "error"; message: string };

/** One card: its details, and Start run, Archive and Restore for a person who can run. */
export function CardPage({
  client,
  id,
  canRun,
  onClose,
}: {
  client: Client;
  id: string;
  canRun: boolean;
  onClose(): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    // `attempt` re-reads the card after a failure or an action.
    void attempt;
    const abort = new AbortController();
    client
      .getCard(id, abort.signal)
      .then((card) => setLoaded({ status: "ready", card }))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setLoaded((current) =>
          current.status === "ready"
            ? current
            : {
                status: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Beehive did not answer",
              },
        );
      });
    return () => abort.abort();
  }, [client, id, attempt]);

  /** Run one action on the card, then read it again. A refusal shows as the engine words it. */
  const act = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setActionError(undefined);
    try {
      await action();
      setAttempt((n) => n + 1);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Beehive did not answer",
      );
    } finally {
      setPending(false);
    }
  };
  const toggleArchive = (card: Card) =>
    act(() =>
      card.archived
        ? client.restoreCard(card.id)
        : client.archiveCards([card.id]),
    );
  const startRun = (card: Card) => act(() => client.startRun(card.id));

  const card = loaded.status === "ready" ? loaded.card : undefined;
  return (
    <div className="beehive-card-page">
      <Header
        title={card?.title ?? "Card"}
        actions={
          <>
            {card && canRun && canStart(card) && (
              <Button
                variant="prominent"
                disabled={pending}
                onClick={() => void startRun(card)}
              >
                Start run
              </Button>
            )}
            {card && canRun && (
              <Button
                loading={pending}
                disabled={pending}
                onClick={() => void toggleArchive(card)}
              >
                {card.archived ? "Restore" : "Archive"}
              </Button>
            )}
            <IconButton
              aria-label="Close card"
              icon={<XIcon size="1rem" />}
              onClick={onClose}
            />
          </>
        }
      />
      {actionError && (
        <p role="alert" className="text-danger">
          {actionError}
        </p>
      )}
      <LoadingRegion
        pending={loaded.status === "loading"}
        label="Loading card…"
        feedback={
          loaded.status === "error" ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {loaded.message}
              </p>
              <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {card && (
          <Tabs
            variant="panel"
            label="Card sections"
            value="details"
            items={[{ value: "details", label: "Details" }]}
            onValueChange={() => {}}
            renderPanel={() => <Details card={card} />}
          />
        )}
      </LoadingRegion>
    </div>
  );
}

/** A card with a workflow and no run in flight can start one. */
function canStart(card: Card): boolean {
  return !card.archived && !!card.workflow && card.state === "idle";
}

function Details({ card }: { card: Card }) {
  return (
    <dl className="beehive-details">
      <div>
        <dt className="text-label text-subtle">State</dt>
        <dd>{card.archived ? "Archived" : stateLabel(card)}</dd>
      </div>
      {card.workflow && (
        <div>
          <dt className="text-label text-subtle">Workflow</dt>
          <dd>{card.workflow}</dd>
        </div>
      )}
      <div>
        <dt className="text-label text-subtle">Description</dt>
        <dd className="beehive-description">
          {card.body || "No description."}
        </dd>
      </div>
    </dl>
  );
}
