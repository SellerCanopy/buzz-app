import { useEffect, useRef, useState, type ReactNode } from "react";
import { LockIcon, SparklesIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Composer } from "../../shared/design-system/ui/Composer";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { EmbeddedThreadProps } from "../conversation/EmbeddedThread";
import type { RelayData } from "../relay/service";
import { AssistantProposal } from "./AssistantProposal";
import { AssistantTicket } from "./AssistantTicket";
import type { Client } from "./engine/client";
import { feedOf } from "./engine/feed";
import { pollErrorHandler } from "./engine/poll";
import { errorMessage } from "./engine/transport";
import type { Event, OpenProposal } from "./gen/kiln/engine/v1/engine_pb";
import { channelOf } from "./SettingsPage";
import { useReadableChannel } from "./useReadableChannel";

const PROMPTS = [
  "Why did this run fail?",
  "Change the open workflow",
  "Summarize what is on the board",
];

/**
 * What the page keeps while the panel is closed, so Back and Forward return to the same thread.
 * `cursor` is the last event of the log the panel has seen: a poll that dropped, or a panel that
 * was closed while a job ran, follows the log again from there, so the job's result is not lost.
 */
export type AssistantSession = {
  /** The thread's root event, which the first job's `job.started` event names. */
  root: string | undefined;
  cursor: bigint;
  /** The job that is running, if one is. */
  job: string | undefined;
  /** Why the last job ended without an answer. */
  failure: string | undefined;
};

export const NEW_THREAD: AssistantSession = {
  root: undefined,
  cursor: 0n,
  job: undefined,
  failure: undefined,
};

type Setup =
  | { status: "loading" }
  | { status: "ready"; channel: string; agent: string }
  | { status: "error"; message: string };

/** What a `job.started` or `job.result` event says about the running job, applied in order. */
function applyEvents(
  session: AssistantSession,
  events: Event[],
): { next: AssistantSession; offered: boolean } {
  let next = session;
  let offered = false;
  for (const event of events) {
    if (event.seq > next.cursor) next = { ...next, cursor: event.seq };
    if (!next.job) continue;
    let body: unknown;
    try {
      body = JSON.parse(event.payloadJson);
    } catch {
      continue;
    }
    if (!body || typeof body !== "object") continue;
    const fields = body as Record<string, unknown>;
    if (fields.job_id !== next.job) continue;
    if (
      event.type === "job.started" &&
      typeof fields.root_event_id === "string"
    ) {
      next = { ...next, root: next.root ?? fields.root_event_id };
    } else if (event.type === "job.result") {
      const failed = fields.state === "failed";
      next = {
        ...next,
        job: undefined,
        failure: failed
          ? `The assistant did not answer: ${typeof fields.reason === "string" ? fields.reason : "it failed"}.`
          : undefined,
      };
      offered = fields.proposal_id != null;
    }
  }
  return { next, offered };
}

/**
 * The assistant: a Buzz agent answers in a thread of the update channel, which is shown here as
 * Channels shows it. Each message starts a job, and the job's result arrives on the event log. A
 * workflow the assistant offers is a card to apply or discard; nothing changes until it is applied. A
 * ticket an agent offered is a card too, and opening its issue is the person's.
 */
export function AssistantPanel({
  client,
  relay,
  Thread,
  canRun,
  isAdmin,
  restored,
  onSession,
  onSaved,
  onClose,
}: {
  client: Client;
  relay: RelayData;
  Thread: (props: EmbeddedThreadProps) => ReactNode;
  canRun: boolean;
  isAdmin: boolean;
  restored: AssistantSession;
  onSession(session: AssistantSession): void;
  /** A proposal was applied, so the workflow list reads again. */
  onSaved(): void;
  onClose(): void;
}) {
  const [setup, setSetup] = useState<Setup>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [proposals, setProposals] = useState<OpenProposal[]>([]);
  const [session, setSession] = useState(restored);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [paused, setPaused] = useState<string>();
  const latest = useRef(session);
  const channel = setup.status === "ready" ? setup.channel : "";
  const readable = useReadableChannel(relay, channel);

  const change = (next: AssistantSession) => {
    latest.current = next;
    setSession(next);
    onSession(next);
  };

  /** Reads the open proposals again, keeping the ones already shown as they are. */
  const readProposals = (signal?: AbortSignal) =>
    client.listProposals(signal).then((reply) => {
      if (signal?.aborted) return;
      setProposals((shown) =>
        reply.proposals.map(
          (proposal) => shown.find((s) => s.id === proposal.id) ?? proposal,
        ),
      );
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: readProposals closes over the client alone.
  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    setSetup({ status: "loading" });
    Promise.all([
      client.getCommunitySettings(abort.signal),
      readProposals(abort.signal),
    ])
      .then(([settings]) => {
        if (abort.signal.aborted) return;
        const value = (key: string) =>
          channelOf(settings.settings.find((s) => s.key === key)?.valueJson);
        setSetup({
          status: "ready",
          channel: value("update_channel"),
          agent: value("assistant_agent"),
        });
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setSetup({ status: "error", message: errorMessage(failure) });
      });
    return () => abort.abort();
  }, [client, attempt]);

  // While a job runs, follow the log from the saved cursor. A poll that drops carries on from
  // its own cursor, and one that cannot (`Retry`) starts again from the saved one.
  const job = session.job;
  const [following, setFollowing] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: change and readProposals are rebuilt on each render and reach only refs, setters and the client.
  useEffect(() => {
    // `following` restarts the poll; it is not otherwise used.
    void following;
    if (!job) return;
    setPaused(undefined);
    return feedOf(client).follow({
      after: latest.current.cursor,
      onEvents: (events) => {
        const { next, offered } = applyEvents(latest.current, events);
        change(next);
        if (offered) void readProposals().catch(() => undefined);
      },
      onError: pollErrorHandler("Beehive assistant updates failed", setPaused),
      onRecover: () => setPaused(undefined),
    });
  }, [client, job, following]);

  const ask = async (message: string) => {
    const body = message.trim();
    if (!body || sending || latest.current.job) return;
    setSending(true);
    setError(undefined);
    try {
      // Follow from before the job starts, so its first event is not missed.
      const { headSeq } = await client.getStatus();
      const started = await client.startChat(body, latest.current.root ?? "");
      change({
        ...latest.current,
        job: started.jobId,
        cursor: headSeq,
        failure: undefined,
      });
      setText("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    const running = latest.current.job;
    if (!running) return;
    setError(undefined);
    try {
      await client.cancelJob(running);
      change({ ...latest.current, job: undefined });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const decided = (id: bigint, applied: boolean) => {
    setProposals((shown) => shown.filter((p) => p.id !== id));
    if (applied) onSaved();
  };

  const ready = setup.status === "ready" ? setup : undefined;
  const noAgent = !!ready && ready.agent === "";
  const empty = !session.root && !session.job;
  const status = session.job ? "Working…" : "Ready";

  let thread: ReactNode = null;
  if (session.root && readable.status === "waiting")
    thread = (
      <p role="status" className="text-subtle">
        Connecting to the community…
      </p>
    );
  else if (session.root && readable.status === "denied")
    thread = (
      <EmptyState
        icon={<LockIcon size="1.5rem" />}
        title="No access to the channel"
        description="The assistant answers in a channel you are not in. Ask a member to add you."
      />
    );
  else if (session.root && readable.status === "readable")
    thread = (
      <div className="beehive-assistant-thread">
        <Thread
          key={`${channel}:${session.root}`}
          session={readable.session}
          scope={readable.session.scope}
          channelId={channel}
          channelName={readable.channel.name}
          messageId={session.root}
        />
      </div>
    );

  return (
    <Dialog
      open
      visit
      placement="right"
      title="Assistant"
      description="Ask for a workflow change. Nothing changes until you apply a proposal."
      onOpenChange={(open) => !open && onClose()}
      headerActions={
        <Button
          size="sm"
          disabled={!!session.job || sending || (empty && !session.failure)}
          onClick={() => {
            change(NEW_THREAD);
            setText("");
            setError(undefined);
          }}
        >
          New
        </Button>
      }
      actions={
        <>
          <Button disabled={!session.job} onClick={() => void stop()}>
            Stop
          </Button>
          <Button variant="prominent" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="beehive-assistant">
        {setup.status === "error" && (
          <div className="beehive-error">
            <p role="alert" className="text-danger">
              {setup.message}
            </p>
            <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        )}
        {ready && (
          <p role="status" className="text-body-sm text-subtle">
            {status}
          </p>
        )}
        {noAgent && (
          <EmptyState
            icon={<SparklesIcon size="1.5rem" />}
            title="No assistant agent"
            description={
              isAdmin
                ? "Choose one under Assistant agent in Settings."
                : "An admin chooses the assistant agent in Settings."
            }
          />
        )}
        {ready && !noAgent && empty && (
          <>
            <EmptyState
              icon={<SparklesIcon size="1.5rem" />}
              title="What can I help with?"
              description="I can see what you have open."
            />
            <SettingsGroup>
              {PROMPTS.map((prompt) => (
                <PreferenceRow
                  key={prompt}
                  title={prompt}
                  trailing={
                    <Button
                      size="sm"
                      aria-label={`Ask ${prompt}`}
                      disabled={sending}
                      onClick={() => void ask(prompt)}
                    >
                      Ask
                    </Button>
                  }
                />
              ))}
            </SettingsGroup>
          </>
        )}
        {thread}
        {paused && (
          <div className="beehive-error">
            <p role="status" className="text-danger">
              {paused}
            </p>
            <Button onClick={() => setFollowing((n) => n + 1)}>Retry</Button>
          </div>
        )}
        {session.failure && (
          <p role="alert" className="text-danger">
            {session.failure}
          </p>
        )}
        {proposals.map((proposal) => {
          const Offer = proposal.ticket ? AssistantTicket : AssistantProposal;
          return (
            <Offer
              key={String(proposal.id)}
              client={client}
              proposal={proposal}
              canRun={canRun}
              onDecided={decided}
            />
          );
        })}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {ready && !noAgent && (
          <Composer
            label="Ask anything..."
            placeholder="Ask anything..."
            value={text}
            onValueChange={setText}
            onSubmit={() => void ask(text)}
            sending={sending}
            disabled={!!session.job}
          />
        )}
      </div>
    </Dialog>
  );
}
