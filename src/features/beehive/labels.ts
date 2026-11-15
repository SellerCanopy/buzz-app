import type { Card, Run, RunStep } from "./gen/kiln/engine/v1/engine_pb";

const STATES: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting",
  failed: "Failed",
  done: "Done",
  stopped: "Stopped",
};

/** The state a person reads: a card with no workflow is in Backlog whatever its state. */
export function stateLabel(card: Card): string {
  if (!card.workflow) return "Backlog";
  return STATES[card.state] ?? card.state;
}

const RUN_STATES: Record<string, string> = {
  running: "Running",
  waiting: "Waiting",
  paused: "Held",
  ended: "Ended",
};

/** `needs_work` as `needs work`: the words a person reads for a result. */
const words = (value: string) => value.replaceAll("_", " ");

/**
 * Where one stage of a run stands, in a line. The stage the run is in reads from the run's
 * state; a stage the card has left reads from its result and where it sent the card.
 */
export function stepStatus(step: RunStep, run: Run, latest: boolean): string {
  if (step.skipped) return "Skipped";
  const parts: string[] = [];
  const current = latest && run.state !== "ended";
  if (current) {
    parts.push(
      step.held && run.state === "paused"
        ? "Held until someone resumes it"
        : (RUN_STATES[run.state] ?? run.state),
    );
  }
  if (step.round > 1) parts.push(`round ${step.round}`);
  if (step.result) {
    parts.push(
      current ? `last result ${words(step.result)}` : words(step.result),
    );
  }
  if (!current && step.routedTo) parts.push(`then ${words(step.routedTo)}`);
  return parts.join(", ") || "Not started";
}

const INBOX_KINDS: Record<string, string> = {
  approval: "Approval",
  question: "Question",
  route: "Decision",
  no_result: "No result",
  missing_output: "Missing output",
  failure: "Failed",
};

/** What kind of wait an inbox item is, in the words a person reads. */
export function inboxKindLabel(kind: string): string {
  return INBOX_KINDS[kind] ?? words(kind);
}

/** The button for one answer an item takes. */
export const CHOICES: Record<
  string,
  { label: string; variant?: "prominent" | "destructive" }
> = {
  approve: { label: "Approve", variant: "prominent" },
  reject: { label: "Reject" },
  reply: { label: "Reply", variant: "prominent" },
  skip: { label: "Skip stage" },
  stop: { label: "Stop run", variant: "destructive" },
  retry: { label: "Retry", variant: "prominent" },
  dismiss: { label: "Dismiss" },
};

/**
 * The artifacts an approval item lists. The engine lists names, as `plan`; an entry that also
 * carries a version reads as `plan (version 2)`.
 */
export function artifactsOf(detailJson: string): string[] {
  try {
    const detail: unknown = JSON.parse(detailJson || "{}");
    const listed = (detail as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((entry: unknown) => {
      if (typeof entry === "string") return entry ? [entry] : [];
      const { name, version } = (entry ?? {}) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof name !== "string") return [];
      return [
        typeof version === "number" ? `${name} (version ${version})` : name,
      ];
    });
  } catch {
    return [];
  }
}
