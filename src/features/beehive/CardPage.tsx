import { useState, type ReactNode } from "react";
import { CaretLeftIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Tabs, type TabItem } from "../../shared/design-system/ui/Tabs";
import type { InboxItem, Run } from "./gen/kiln/engine/v1/engine_pb";
import type { EmbeddedThreadProps } from "../conversation/EmbeddedThread";
import type { Navigation } from "../navigation/controller";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import { ActivityTab } from "./ActivityTab";
import { ApprovalCallout } from "./ApprovalCallout";
import {
  currentStage,
  inState,
  issueOf,
  progressOf,
  statusOf,
  stripOf,
  type Progress,
} from "./boardModel";
import { Callout } from "./Callout";
import { CardConfirm } from "./CardConfirm";
import { CardMenu } from "./CardMenu";
import { canPause, canRetry, canStart, canStop, isWebUrl } from "./cardActions";
import { Details, pullState } from "./CardDetails";
import { FilesTab } from "./FilesTab";
import { stepStatus, subjectOf } from "./labels";
import { IssueTab } from "./IssueTab";
import { LiveTab } from "./LiveTab";
import { RejectDialog } from "./RejectDialog";
import { ReposTab } from "./ReposTab";
import type { CardTab } from "./routes";
import { StageStrip } from "./StageStrip";
import { useCard, useCardActions } from "./useCard";

/**
 * One card: a way back to the board, its facts and the stages of its workflow above the tabs. The
 * tabs are the issue, the current stage's thread, the stages its latest run went through, the
 * files they saved, what happened on it, the repos it works in and its details. A person who can
 * run starts, holds, stops and retries the run from the header, merges and archives from Details,
 * adds and removes repos on the Repos tab, and approves or sends back the card's approval wherever
 * it shows. A person who can run also turns auto mode on
 * and off: while it is on the engine answers the card's approval gates, failed runs and silent
 * stages by rule. The tab is part of the page's route, so Back returns to the tab a person left.
 */
export function CardPage({
  client,
  relay,
  navigator,
  Thread,
  onOpenThread,
  id,
  tab,
  canRun,
  waiting,
  onAnswered,
  onTab,
  onClose,
}: {
  client: Client;
  relay: RelayData | undefined;
  navigator: Navigation | undefined;
  Thread: (props: EmbeddedThreadProps) => ReactNode;
  /** Shows a stage's thread where there is no relay to embed it. */
  onOpenThread?: ((channelId: string, rootEventId: string) => void) | undefined;
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
  const { loaded, setLoaded, workflows, reload } = useCard(client, id);
  const {
    pending,
    error: actionError,
    clearError,
    confirm,
    setConfirm,
    confirmed,
    act,
    toggleArchive,
    startRun,
    pause,
    resume,
    setAutoMode,
    answer,
  } = useCardActions(client, reload, onAnswered, onClose);
  // A reject asks for its reason, which is a transient surface too and has no history visit.
  const [rejecting, setRejecting] = useState(false);

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
  // A card with an issue or repos has repos to show. One written by hand and not yet run has none
  // yet and takes its first here. One that has run and has none, such as a failed fault card, has
  // no tab.
  if (card && (card.issue || card.repos.length > 0 || inState(card, "idle")))
    sections.push({ value: "repos", label: "Repos" });
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
              <CardMenu
                issueLink={issueLink}
                pullLink={pullLink}
                canReset={canReset}
                canRun={canRun}
                onConfirm={setConfirm}
              />
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
        <RejectDialog
          subject={subject}
          pending={pending}
          error={actionError}
          onClose={() => {
            setRejecting(false);
            clearError();
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
          <Button onClick={() => reload()}>Retry</Button>
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
              <Button onClick={() => reload()}>Retry</Button>
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
                    <ApprovalCallout
                      subject={subject}
                      canRun={canRun}
                      pending={pending}
                      onReject={() => setRejecting(true)}
                      onApprove={() => void answer(approval, "approve")}
                    />
                  )}
                  <LiveTab
                    card={card}
                    relay={relay}
                    navigator={navigator}
                    Thread={Thread}
                    onOpenThread={onOpenThread}
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
              ) : value === "repos" ? (
                <ReposTab
                  client={client}
                  card={card}
                  canRun={canRun}
                  onChanged={(next) =>
                    setLoaded((current) =>
                      current.status === "ready"
                        ? { ...current, card: next }
                        : current,
                    )
                  }
                />
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
