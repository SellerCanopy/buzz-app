import { useEffect, useState } from "react";
import { XIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Tabs, type TabItem } from "../../shared/design-system/ui/Tabs";
import type { Card, Run } from "./gen/kiln/engine/v1/engine_pb";
import type { Client } from "./engine/client";
import { stateLabel, stepStatus } from "./labels";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; card: Card; run: Run | undefined }
  | { status: "error"; message: string };

type Section = "details" | "steps";

/**
 * One card: its details and the stages its latest run went through, and Start run, Resume,
 * Archive and Restore for a person who can run.
 */
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
  const [section, setSection] = useState<Section>("details");

  useEffect(() => {
    // `attempt` re-reads the card after a failure or an action.
    void attempt;
    const abort = new AbortController();
    Promise.all([
      client.getCard(id, abort.signal),
      client.listRuns(id, abort.signal),
    ])
      // The newest run is first.
      .then(([card, runs]) =>
        setLoaded({ status: "ready", card, run: runs.runs[0] }),
      )
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
  const resume = (card: Card) => act(() => client.resumeCard(card.id));

  const card = loaded.status === "ready" ? loaded.card : undefined;
  const run = loaded.status === "ready" ? loaded.run : undefined;
  const hasSteps = !!run?.steps.length;
  const sections: TabItem<Section>[] = [{ value: "details", label: "Details" }];
  if (hasSteps) sections.push({ value: "steps", label: "Steps" });
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
            {card && canRun && run?.state === "paused" && (
              <Button
                variant="prominent"
                disabled={pending}
                onClick={() => void resume(card)}
              >
                Resume
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
            value={hasSteps ? section : "details"}
            items={sections}
            onValueChange={setSection}
            renderPanel={(value) =>
              value === "steps" && run ? (
                <Steps run={run} />
              ) : (
                <Details card={card} />
              )
            }
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

/** The stages the run entered, oldest first, each with where it stands. */
function Steps({ run }: { run: Run }) {
  return (
    <ol className="beehive-steps" aria-label="Stages of the run">
      {run.steps.map((step, index) => (
        <li key={`${step.stage}:${step.visit}`}>
          <span>{step.stage}</span>
          <span className="text-body-sm text-subtle">
            {stepStatus(step, run, index === run.steps.length - 1)}
          </span>
          {step.summary && (
            <span className="beehive-step-summary text-body-sm">
              {step.summary}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
