import { stateWords } from "./boardModel";
import type { Card, Run, RunStep } from "./gen/kiln/engine/v1/engine_pb";

/** The state a person reads: a card with no workflow is in Backlog whatever its state. */
export function stateLabel(card: Card): string {
  if (!card.workflow) return "Backlog";
  return stateWords(card.state);
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
  route: "Route",
  no_result: "No result",
  missing_output: "Missing output",
  failure: "Failure",
};

/** The kinds the engine raises, in the order the Needs you tabs list them. */
export const INBOX_KIND_ORDER = Object.keys(INBOX_KINDS);

/** What kind of wait an inbox item is, in the words a person reads. */
export function inboxKindLabel(kind: string): string {
  return INBOX_KINDS[kind] ?? words(kind);
}

/**
 * How long an item has waited, as `waiting 40m`. Under a minute reads `waiting under 1m`; an
 * item with no time says nothing. `now` is milliseconds since the epoch.
 */
export function waitedLabel(
  openedAt: { seconds: bigint } | undefined,
  now: number,
): string {
  if (!openedAt) return "";
  const minutes = Math.floor((now / 1000 - Number(openedAt.seconds)) / 60);
  if (minutes < 1) return "waiting under 1m";
  if (minutes < 60) return `waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `waiting ${hours}h`
    : `waiting ${Math.floor(hours / 24)}d`;
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
 * The button for one answer of an item of `kind`. A failure's Retry starts the run again; on a
 * stage that ended without a result or an output it runs the stage again.
 */
export function choiceLabel(kind: string, choice: string): string {
  if (choice === "retry")
    return kind === "failure" ? "Retry run" : "Retry stage";
  return CHOICES[choice]?.label ?? choice;
}

/** The artifacts an approval item lists, each with its version when the entry carries one. */
function entriesOf(detailJson: string): { name: string; version?: number }[] {
  try {
    const detail: unknown = JSON.parse(detailJson || "{}");
    const listed = (detail as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((entry: unknown) => {
      if (typeof entry === "string") return entry ? [{ name: entry }] : [];
      const { name, version } = (entry ?? {}) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof name !== "string") return [];
      return [typeof version === "number" ? { name, version } : { name }];
    });
  } catch {
    return [];
  }
}

/**
 * The artifacts an approval item lists. The engine lists names, as `plan`; an entry that also
 * carries a version reads as `plan v2`.
 */
export function artifactsOf(detailJson: string): string[] {
  return entriesOf(detailJson).map(({ name, version }) =>
    version === undefined ? name : `${name} v${version}`,
  );
}

/** The one artifact an approval is about, as `plan`, or empty when it lists none or several. */
export function subjectOf(detailJson: string): string {
  const listed = entriesOf(detailJson);
  return listed.length === 1 ? (listed[0]?.name ?? "") : "";
}
