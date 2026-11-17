import { useCallback, useEffect, useState } from "react";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { Confirm } from "./CardConfirm";
import type {
  Card,
  InboxItem,
  Run,
  Workflow,
} from "./gen/kiln/engine/v1/engine_pb";

export type Loaded =
  | { status: "loading" }
  /** `stale` says the last read after an action failed, so what shows may be out of date. */
  | { status: "ready"; card: Card; run: Run | undefined; stale?: string }
  | { status: "error"; message: string };

/**
 * What a card page shows: the card and its newest run, and the workflows that name its stages.
 * `reload` reads the card again, after a failure or an action. A failed read of the workflows
 * says nothing, since the page reads the same without the stage strip.
 */
export function useCard(client: Client, id: string) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [workflows, setWorkflows] = useState<Workflow[]>();
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    // `attempt` re-reads the card.
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

  return { loaded, setLoaded, workflows, reload };
}

/**
 * What a person does to a card: one action at a time, each read back through `reload`, with the
 * engine's refusal kept word for word. `confirmed` runs the action the open confirmation asked
 * for; a removed card has no page to read again, so it calls `onClose`.
 */
export function useCardActions(
  client: Client,
  reload: () => void,
  onAnswered: () => void,
  onClose: () => void,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // Stopping, merging, resetting and removing ask first. The question is a transient surface,
  // so it has no history visit.
  const [confirm, setConfirm] = useState<Confirm>();

  /** Runs one action, then reads the card again unless `again` is off. Reports whether it went through. */
  const act = async (
    action: () => Promise<unknown>,
    again = true,
  ): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    setError(undefined);
    try {
      await action();
      if (again) reload();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setPending(false);
    }
  };

  /** Runs what the open confirmation asked for, then closes it. */
  const confirmed = async (card: Card, run: Run | undefined) => {
    const done = await (confirm === "stop" && run
      ? act(() => client.stopRun(run.id))
      : confirm === "skip"
        ? act(() => client.skipStage(card.id))
        : confirm === "merge"
          ? act(() => client.mergeCard(card.id))
          : confirm === "reset"
            ? act(() => client.resetCard(card.id))
            : confirm === "remove"
              ? act(() => client.removeCard(card.id), false)
              : Promise.resolve(false));
    setConfirm(undefined);
    if (done && confirm === "remove") onClose();
  };

  return {
    pending,
    error,
    clearError: () => setError(undefined),
    confirm,
    setConfirm,
    confirmed,
    act,
    toggleArchive: (card: Card) =>
      act(() =>
        card.archived
          ? client.restoreCard(card.id)
          : client.archiveCards([card.id]),
      ),
    startRun: (card: Card) => act(() => client.startRun(card.id)),
    pause: (card: Card) => act(() => client.pauseCard(card.id)),
    resume: (card: Card) => act(() => client.resumeCard(card.id)),
    setAutoMode: (card: Card, enabled: boolean) =>
      act(() => client.setAutoMode(card.id, enabled)),
    answer: (item: InboxItem, choice: string, text = "") =>
      act(async () => {
        await client.answerInbox(item.id, choice, text);
        onAnswered();
      }),
  };
}
