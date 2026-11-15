import { useEffect, useRef, useState, type ReactNode } from "react";
import { XIcon } from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Tabs, type TabItem } from "../../shared/design-system/ui/Tabs";
import type { Card, Run } from "./gen/kiln/engine/v1/engine_pb";
import type { EmbeddedThreadProps } from "../conversation/EmbeddedThread";
import type { Navigation } from "../navigation/controller";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import { FilesTab } from "./FilesTab";
import { stateLabel, stepStatus } from "./labels";
import { LiveTab } from "./LiveTab";
import type { CardTab } from "./routes";

type Loaded =
  | { status: "loading" }
  /** `stale` says the last read after an action failed, so what shows may be out of date. */
  | { status: "ready"; card: Card; run: Run | undefined; stale?: string }
  | { status: "error"; message: string };

/**
 * One card: the current stage's thread, the stages its latest run went through, the files they
 * saved and its details, and Start run, Resume, Stop run, Retry run, Archive and Restore for a
 * person who can run.
 * The tab is part of the page's route, so Back returns to the tab a person left.
 */
export function CardPage({
  client,
  relay,
  navigator,
  Thread,
  id,
  tab,
  canRun,
  onTab,
  onClose,
}: {
  client: Client;
  relay: RelayData;
  navigator: Navigation | undefined;
  Thread: (props: EmbeddedThreadProps) => ReactNode;
  id: string;
  /** The tab the visit names; the card's own default when it names none. */
  tab: CardTab | undefined;
  canRun: boolean;
  onTab(tab: CardTab): void;
  onClose(): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  // Stopping asks first. The confirmation is a transient surface, so it has no history visit.
  const [confirmStop, setConfirmStop] = useState(false);
  const cancelStop = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // `attempt` re-reads the card after a failure or an action.
    void attempt;
    const abort = new AbortController();
    Promise.all([
      client.getCard(id, abort.signal),
      client.listRuns(id, abort.signal),
    ])
      // The newest run is first.
      .then(([card, runs]) => {
        if (abort.signal.aborted) return;
        setLoaded({ status: "ready", card, run: runs.runs[0] });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const message = errorMessage(error);
        // A card already on screen stays, with the failure said beside it.
        setLoaded((current) =>
          current.status === "ready"
            ? { ...current, stale: message }
            : { status: "error", message },
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
      setActionError(errorMessage(error));
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
  const stop = (current: Run) => act(() => client.stopRun(current.id));
  const retry = (current: Run) => act(() => client.retryRun(current.id));

  const card = loaded.status === "ready" ? loaded.card : undefined;
  const run = loaded.status === "ready" ? loaded.run : undefined;
  const hasSteps = !!run?.steps.length;
  // A card with no run has no thread and has saved nothing, so those tabs wait for the first run.
  const sections: TabItem<CardTab>[] = [];
  if (run) sections.push({ value: "live", label: "Live" });
  if (hasSteps) sections.push({ value: "steps", label: "Steps" });
  if (run) sections.push({ value: "files", label: "Files" });
  sections.push({ value: "details", label: "Details" });
  const fallback: CardTab = card?.stages.length ? "live" : "details";
  const section = tab && sections.some((s) => s.value === tab) ? tab : fallback;
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
            {card && run && canRun && canStop(run) && (
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => setConfirmStop(true)}
              >
                Stop run
              </Button>
            )}
            {card && run && canRun && canRetry(card, run) && (
              <Button
                variant="prominent"
                disabled={pending}
                onClick={() => void retry(run)}
              >
                Retry run
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
      {confirmStop && run && (
        <AlertDialog
          title="Stop this run?"
          description="The run ends and the card moves to Stopped. What its stages already saved stays, and you can retry the run afterwards."
          pending={pending}
          initialFocus={cancelStop}
          onClose={() => setConfirmStop(false)}
          actions={
            <>
              <Button
                ref={cancelStop}
                disabled={pending}
                onClick={() => setConfirmStop(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={pending}
                onClick={() => void stop(run).then(() => setConfirmStop(false))}
              >
                Stop run
              </Button>
            </>
          }
        />
      )}
      {actionError && (
        <p role="alert" className="text-danger">
          {actionError}
        </p>
      )}
      {loaded.status === "ready" && loaded.stale && (
        <div className="beehive-error">
          <p role="alert" className="text-danger">
            {`The card may be out of date. ${loaded.stale}`}
          </p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
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
            value={section}
            items={sections}
            onValueChange={onTab}
            renderPanel={(value) =>
              value === "live" && run ? (
                <LiveTab
                  card={card}
                  relay={relay}
                  navigator={navigator}
                  Thread={Thread}
                />
              ) : value === "steps" && run ? (
                <Steps run={run} />
              ) : value === "files" && run ? (
                <FilesTab client={client} relay={relay} cardId={card.id} />
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

/** A run that has not ended can be stopped. */
function canStop(run: Run): boolean {
  return run.state !== "ended";
}

/** A card whose run failed or was stopped can start again from the stage it reached. */
function canRetry(card: Card, run: Run): boolean {
  return (
    !card.archived &&
    run.state === "ended" &&
    (card.state === "failed" || card.state === "stopped")
  );
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
          {step.failure && (
            <span className="beehive-step-summary text-body-sm text-danger">
              {step.failure}
            </span>
          )}
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
