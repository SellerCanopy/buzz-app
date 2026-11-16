import { useEffect, useState, type ReactNode } from "react";
import { CaretLeftIcon, DotsThreeIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Tabs, type TabItem } from "../../shared/design-system/ui/Tabs";
import type {
  Card,
  InboxItem,
  Run,
  Workflow,
} from "./gen/kiln/engine/v1/engine_pb";
import type { EmbeddedThreadProps } from "../conversation/EmbeddedThread";
import type { Navigation } from "../navigation/controller";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import { TextDialog } from "./AnswerDialog";
import { ActivityTab } from "./ActivityTab";
import {
  currentStage,
  issueOf,
  progressOf,
  statusOf,
  stripOf,
  type Progress,
} from "./boardModel";
import { Callout } from "./Callout";
import { CardConfirm, type Confirm } from "./CardConfirm";
import { canPause, canRetry, canStart, canStop, isWebUrl } from "./cardActions";
import { Details, pullState } from "./CardDetails";
import { FilesTab } from "./FilesTab";
import { stepStatus, subjectOf } from "./labels";
import { IssueTab } from "./IssueTab";
import { LiveTab } from "./LiveTab";
import type { CardTab } from "./routes";
import { StageStrip } from "./StageStrip";

type Loaded =
  | { status: "loading" }
  /** `stale` says the last read after an action failed, so what shows may be out of date. */
  | { status: "ready"; card: Card; run: Run | undefined; stale?: string }
  | { status: "error"; message: string };

/**
 * One card: a way back to the board, its facts and the stages of its workflow above the tabs. The
 * tabs are the issue, the current stage's thread, the stages its latest run went through, the
 * files they saved, what happened on it and its details. A person who can run starts, holds,
 * stops and retries the run from the header, merges and archives from Details, and approves or
 * sends back the card's approval wherever it shows. A person who can run also turns auto mode on
 * and off: while it is on the engine answers the card's approval gates, failed runs and silent
 * stages by rule. The tab is part of the page's route, so Back returns to the tab a person left.
 */
export function CardPage({
  client,
  relay,
  navigator,
  Thread,
  id,
  tab,
  canRun,
  waiting,
  onAnswered,
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
  /** The open items of the inbox, of every card. */
  waiting: InboxItem[];
  /** The inbox changed, so it should be read again. */
  onAnswered(): void;
  onTab(tab: CardTab): void;
  onClose(): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [workflows, setWorkflows] = useState<Workflow[]>();
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  // Stopping, merging, resetting and removing ask first, and a reject asks for its reason. These
  // are transient surfaces, so none has a history visit.
  const [confirm, setConfirm] = useState<Confirm>();
  const [rejecting, setRejecting] = useState(false);

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

  // The stage strip needs the workflow's stages. Without them the page reads the same without
  // the strip, so a failed read says nothing.
  useEffect(() => {
    const abort = new AbortController();
    void Promise.resolve()
      .then(() => client.listWorkflows(abort.signal))
      .then(
        (reply) => !abort.signal.aborted && setWorkflows(reply.workflows),
        () => undefined,
      );
    return () => abort.abort();
  }, [client]);

  /**
   * Run one action on the card, then read it again unless `reload` is off. A refusal shows as
   * the engine words it. Reports whether the action went through.
   */
  const act = async (
    action: () => Promise<unknown>,
    reload = true,
  ): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    setActionError(undefined);
    try {
      await action();
      if (reload) setAttempt((n) => n + 1);
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      return false;
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
  const pause = (card: Card) => act(() => client.pauseCard(card.id));
  const resume = (card: Card) => act(() => client.resumeCard(card.id));
  const setAutoMode = (current: Card, enabled: boolean) =>
    act(() => client.setAutoMode(current.id, enabled));
  const answer = (item: InboxItem, choice: string, text = "") =>
    act(async () => {
      await client.answerInbox(item.id, choice, text);
      onAnswered();
    });
  /** Runs what the open confirmation asked for, then closes it. */
  const confirmed = async (card: Card, run: Run | undefined) => {
    const done = await (confirm === "stop" && run
      ? act(() => client.stopRun(run.id))
      : confirm === "merge"
        ? act(() => client.mergeCard(card.id))
        : confirm === "reset"
          ? act(() => client.resetCard(card.id))
          : confirm === "remove"
            ? act(() => client.removeCard(card.id), false)
            : Promise.resolve(false));
    setConfirm(undefined);
    // A removed card has no page to read again.
    if (done && confirm === "remove") onClose();
  };

  const card = loaded.status === "ready" ? loaded.card : undefined;
  const run = loaded.status === "ready" ? loaded.run : undefined;
  const mine = waiting.filter((item) => item.cardId === id);
  const approval = mine.find((item) => item.kind === "approval");
  const subject = approval ? subjectOf(approval.detailJson) : "";
  const workflow = workflows?.find((item) => item.name === card?.workflow);
  const strip = stripOf(run, workflow);
  const at = currentStage(run, strip);
  const status = card ? statusOf(card, mine) : undefined;
  const hasSteps = !!run?.steps.length;
  // A card with no run has no thread and has saved nothing, so those tabs wait for the first run.
  const sections: TabItem<CardTab>[] = [];
  // A card made from an issue also shows the issue, as the host last returned it.
  if (card?.issue) sections.push({ value: "issue", label: "Issue" });
  if (run) sections.push({ value: "live", label: "Live" });
  if (hasSteps) sections.push({ value: "steps", label: "Steps" });
  if (run) sections.push({ value: "files", label: "Files" });
  sections.push({ value: "activity", label: "Activity" });
  sections.push({ value: "details", label: "Details" });
  const fallback: CardTab = card?.stages.length ? "live" : "details";
  const section = tab && sections.some((s) => s.value === tab) ? tab : fallback;
  const pull = card?.pullRequest;
  const issueLink = card && isWebUrl(card.issueUrl) ? card.issueUrl : "";
  const pullLink = pull && isWebUrl(pull.url) ? pull.url : "";
  const canReset = !!card && canRun && !card.archived && !!run;
  const hasMenu = !!issueLink || !!pullLink || canReset || canRun;
  return (
    <div className="beehive-card-page">
      <div className="beehive-crumb">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to Board"
          onClick={onClose}
        >
          <CaretLeftIcon size="1rem" aria-hidden="true" />
          Board
        </Button>
      </div>
      <Header
        title={card?.title ?? "Card"}
        subtitle={
          card &&
          status && (
            <span className="beehive-meta">
              <span
                className="beehive-status text-body-sm"
                data-tone={status.tone}
              >
                {card.archived ? "Archived" : status.label}
              </span>
              {issueOf(card) && <code>{issueOf(card)}</code>}
              {pull && (
                <span>
                  {pullLink ? (
                    <Button
                      variant="link"
                      size="text"
                      role="link"
                      nativeButton={false}
                      render={
                        <a href={pullLink} target="_blank" rel="noreferrer" />
                      }
                    >
                      {`Pull request #${pull.number}`}
                    </Button>
                  ) : (
                    `Pull request #${pull.number}`
                  )}
                  {` ${pullState(pull.state, pull.draft)}`}
                </span>
              )}
              {card.workflow && <span>{`Workflow ${card.workflow}`}</span>}
            </span>
          )
        }
        actions={
          <>
            {card && canRun && !card.archived && (
              <Switch
                label="Auto mode"
                checked={card.autoMode}
                disabled={pending}
                onCheckedChange={(enabled) => void setAutoMode(card, enabled)}
              />
            )}
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
            {card && canRun && canPause(card, run) && (
              <Button disabled={pending} onClick={() => void pause(card)}>
                Pause
              </Button>
            )}
            {card && run && canRun && canStop(run) && (
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => setConfirm("stop")}
              >
                Stop run
              </Button>
            )}
            {card && run && canRun && canRetry(card, run) && (
              <Button
                variant="prominent"
                disabled={pending}
                onClick={() => void act(() => client.retryRun(run.id))}
              >
                Retry run
              </Button>
            )}
            {card && hasMenu && (
              <MenuRoot>
                <MenuTrigger
                  render={
                    <IconButton
                      aria-label="More actions"
                      icon={<DotsThreeIcon size="1rem" />}
                    />
                  }
                />
                <MenuPopup>
                  {(issueLink || pullLink) && (
                    <MenuGroup>
                      <MenuGroupLabel>Open from this card</MenuGroupLabel>
                      {issueLink && (
                        <MenuLinkItem
                          href={issueLink}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open issue
                        </MenuLinkItem>
                      )}
                      {pullLink && (
                        <MenuLinkItem
                          href={pullLink}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open pull request
                        </MenuLinkItem>
                      )}
                    </MenuGroup>
                  )}
                  {(issueLink || pullLink) && canRun && <MenuSeparator />}
                  {canReset && (
                    <MenuItem onClick={() => setConfirm("reset")}>
                      Reset this card
                    </MenuItem>
                  )}
                  {canRun && (
                    <MenuItem
                      tone="danger"
                      onClick={() => setConfirm("remove")}
                    >
                      Remove this card
                    </MenuItem>
                  )}
                </MenuPopup>
              </MenuRoot>
            )}
          </>
        }
      />
      {card && (
        <StageStrip
          stages={strip}
          caption={
            at === undefined || !status
              ? undefined
              : `${strip[at]?.stage}, ${mine.length > 0 ? "needs you" : status.label.toLowerCase()}. Step ${at + 1} of ${strip.length}`
          }
        />
      )}
      {card && approval && section !== "live" && (
        <Callout
          tone="warning"
          title="Ready for review"
          actions={
            <Button size="sm" onClick={() => onTab("live")}>
              Jump to it
            </Button>
          }
        >
          {subject
            ? `Approve the ${subject}, or send it back with a reason.`
            : "Approve it, or send it back with a reason."}
        </Callout>
      )}
      {confirm && card && (
        <CardConfirm
          kind={confirm}
          pending={pending}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => void confirmed(card, run)}
        />
      )}
      {rejecting && approval && (
        <TextDialog
          kind="reject"
          subject={subject}
          pending={pending}
          error={actionError}
          onClose={() => {
            setRejecting(false);
            setActionError(undefined);
          }}
          onSubmit={async (text) => {
            if (await answer(approval, "reject", text)) setRejecting(false);
          }}
        />
      )}
      {actionError && !rejecting && (
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
                <>
                  {approval && (
                    <Callout
                      tone="warning"
                      title="Waiting for your approval"
                      actions={
                        canRun ? (
                          <>
                            <Button
                              disabled={pending}
                              onClick={() => setRejecting(true)}
                            >
                              Reject
                            </Button>
                            <Button
                              variant="prominent"
                              disabled={pending}
                              onClick={() => void answer(approval, "approve")}
                            >
                              Approve
                            </Button>
                          </>
                        ) : undefined
                      }
                    >
                      {subject
                        ? `Review the ${subject}, then approve it or send it back with a note.`
                        : "Review it, then approve it or send it back with a note."}
                    </Callout>
                  )}
                  <LiveTab
                    card={card}
                    relay={relay}
                    navigator={navigator}
                    Thread={Thread}
                  />
                </>
              ) : value === "steps" && run ? (
                <Steps
                  run={run}
                  progress={progressOf(card, run, workflow)}
                  review={!!approval}
                  onOpenLive={() => onTab("live")}
                />
              ) : value === "files" && run ? (
                <FilesTab client={client} relay={relay} cardId={card.id} />
              ) : value === "activity" ? (
                <ActivityTab client={client} cardId={card.id} />
              ) : value === "issue" && card.issue ? (
                <IssueTab client={client} card={card} />
              ) : (
                <Details
                  card={card}
                  canRun={canRun}
                  pending={pending}
                  onMerge={() => setConfirm("merge")}
                  onArchive={() => void toggleArchive(card)}
                />
              )
            }
          />
        )}
      </LoadingRegion>
    </div>
  );
}

/**
 * The stages the run entered, oldest first, each with where it stands, under a count of those
 * done. The stage the card waits on for an approval says so and links to where it is answered.
 */
function Steps({
  run,
  progress,
  review,
  onOpenLive,
}: {
  run: Run;
  progress: Progress | undefined;
  /** The card waits on an approval, which is of the run's latest step. */
  review: boolean;
  onOpenLive(): void;
}) {
  return (
    <>
      {progress && (
        <p className="beehive-steps-count text-body-sm text-subtle">
          {`${progress.done} of ${progress.total} steps done`}
        </p>
      )}
      <ol className="beehive-steps" aria-label="Steps of the run">
        {run.steps.map((step, index) => {
          const latest = index === run.steps.length - 1;
          return (
            <li key={`${step.stage}:${step.visit}`}>
              <span>{step.stage}</span>
              <span className="text-body-sm text-subtle">
                {review && latest
                  ? "Ready for review"
                  : stepStatus(step, run, latest)}
              </span>
              {review && latest && (
                <Button variant="link" size="text" onClick={onOpenLive}>
                  Open it on Live
                </Button>
              )}
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
          );
        })}
      </ol>
    </>
  );
}
