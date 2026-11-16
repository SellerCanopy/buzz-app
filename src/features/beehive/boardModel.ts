import type {
  Card,
  InboxItem,
  Run,
  Workflow,
} from "./gen/kiln/engine/v1/engine_pb";

/** The board's four lanes, left to right. */
export const LANES = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "To do" },
  { key: "progress", label: "In progress" },
  { key: "done", label: "Done" },
] as const;

export type Lane = (typeof LANES)[number]["key"];

/**
 * The lane a card is in. Backlog has no workflow. A card with one waits in To do until a run
 * starts, is In progress while a run works, waits for a person or has stopped, and is Done when
 * it finished.
 */
export function laneOf(card: Card): Lane {
  if (!card.workflow) return "backlog";
  switch (card.state) {
    case "running":
    case "waiting":
    case "failed":
    case "stopped":
      return "progress";
    case "done":
      return "done";
    default:
      return "todo";
  }
}

/** The repo a card's issue lives in as `owner/name`, or empty when the card has no issue. */
export function repoOf(card: Card): string {
  return card.issue ? `${card.issue.owner}/${card.issue.repo}` : "";
}

/** The issue a card was made from as `owner/name#number`, or empty. */
export function issueOf(card: Card): string {
  return card.issue ? `${repoOf(card)}#${card.issue.number}` : "";
}

/** When a run started, as nanoseconds; a run with no time sorts first. */
function startedAt(run: Run): bigint {
  const at = run.startedAt;
  return at ? at.seconds * 1_000_000_000n + BigInt(at.nanos) : 0n;
}

/** The newest run of each card, by the time it started. */
export function latestRuns(runs: Run[]): Map<string, Run> {
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const seen = latest.get(run.cardId);
    if (!seen || startedAt(run) > startedAt(seen)) latest.set(run.cardId, run);
  }
  return latest;
}

/** The stage ids of the run's steps, in the order they were first reached. */
function reached(run: Run): string[] {
  return [...new Set(run.steps.map((step) => step.stage))];
}

/** The newest step of one stage. */
function lastStep(run: Run, stage: string) {
  return [...run.steps].reverse().find((step) => step.stage === stage);
}

export type Progress = { done: number; total: number };

/**
 * How many of the workflow's stages the card has finished. A stage is finished when its newest
 * step passed or was skipped; a finished card has finished them all. Without the workflow there
 * is no total, so there is no progress to show.
 */
export function progressOf(
  card: Card,
  run: Run | undefined,
  workflow: Workflow | undefined,
): Progress | undefined {
  const total = workflow?.stages.length ?? 0;
  if (!total) return undefined;
  if (card.state === "done") return { done: total, total };
  if (!run) return { done: 0, total };
  const done = reached(run).filter((stage) => {
    const step = lastStep(run, stage);
    return !!step && (step.skipped || step.result === "passed");
  }).length;
  return { done: Math.min(done, total), total };
}

export type Chip = {
  stage: string;
  /** How the stage stands, in the words a screen reader says. */
  status: "done" | "failed" | "running" | "next" | "idle";
};

/** The most chips a tile shows; the newest stages win. */
const MAX_CHIPS = 4;

/**
 * The stages a tile lists: those the card's run reached, then the one the workflow lists after
 * the last of them. A card that has not run lists the workflow's first two stages.
 */
export function chipsOf(
  run: Run | undefined,
  workflow: Workflow | undefined,
): Chip[] {
  const stages = workflow?.stages.map((stage) => stage.id) ?? [];
  if (!run) {
    return stages.slice(0, 2).map((stage) => ({ stage, status: "idle" }));
  }
  const chips: Chip[] = reached(run).map((stage) => {
    const step = lastStep(run, stage);
    if (step?.skipped || step?.result === "passed")
      return { stage, status: "done" };
    if (step?.result) return { stage, status: "failed" };
    if (run.state !== "ended" && stage === run.stageId)
      return { stage, status: "running" };
    return { stage, status: "idle" };
  });
  const last = chips.at(-1);
  const after = last ? stages.indexOf(last.stage) + 1 : 0;
  const next = stages[after];
  if (next && after > 0 && !chips.some((chip) => chip.stage === next))
    chips.push({ stage: next, status: "next" });
  return chips.slice(-MAX_CHIPS);
}

export type Status = {
  label: string;
  tone: "neutral" | "info" | "warning" | "danger" | "success";
};

/**
 * What a tile says about the card's state. An open item the card waits on decides the words:
 * an approval is ready for review and a question wants an answer. A card that failed or
 * waits on any other decision needs the person.
 */
export function statusOf(card: Card, waitingOn: InboxItem[]): Status {
  const open = waitingOn.filter((item) => !item.resolvedAt);
  if (open.some((item) => item.kind === "approval"))
    return { label: "Ready for review", tone: "warning" };
  if (open.some((item) => item.kind === "question"))
    return { label: "Question for you", tone: "warning" };
  if (open.length > 0 || card.state === "failed")
    return { label: "Needs you", tone: "danger" };
  switch (card.state) {
    case "running":
      return { label: "Running", tone: "info" };
    case "waiting":
      return { label: "Waiting", tone: "warning" };
    case "stopped":
      return { label: "Stopped", tone: "neutral" };
    case "done":
      return { label: "Done", tone: "success" };
    default:
      return { label: "Idle", tone: "neutral" };
  }
}

/** The open inbox items of each card. */
export function waitingByCard(items: InboxItem[]): Map<string, InboxItem[]> {
  const byCard = new Map<string, InboxItem[]>();
  for (const item of items) {
    if (item.resolvedAt || !item.cardId) continue;
    byCard.set(item.cardId, [...(byCard.get(item.cardId) ?? []), item]);
  }
  return byCard;
}

export const STATE_FILTERS = [
  { value: "idle", label: "Idle" },
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "failed", label: "Failed" },
  { value: "stopped", label: "Stopped" },
  { value: "done", label: "Done" },
] as const;

/** The value of a filter that lets every card through. */
export const ALL = "all";
/** The Workflow filter's value for a card with no workflow. */
export const NO_WORKFLOW = "none";

export type Filters = {
  text: string;
  state: string;
  repo: string;
  workflow: string;
};

export const NO_FILTERS: Filters = {
  text: "",
  state: ALL,
  repo: ALL,
  workflow: ALL,
};

/**
 * Whether the search text matches a card: its title as plain text, or its issue number as
 * `#42` or `42`.
 */
export function matchesText(card: Card, text: string): boolean {
  const query = text.trim().toLowerCase();
  if (!query) return true;
  if (card.title.toLowerCase().includes(query)) return true;
  const number = card.issue?.number;
  return (
    number !== undefined &&
    number > 0 &&
    `${number}` === query.replace(/^#/, "")
  );
}

/** Whether a card passes the filters, except the one named by `skip`. */
export function passes(
  card: Card,
  filters: Filters,
  skip?: keyof Filters,
): boolean {
  if (skip !== "text" && !matchesText(card, filters.text)) return false;
  if (skip !== "state" && filters.state !== ALL && card.state !== filters.state)
    return false;
  if (skip !== "repo" && filters.repo !== ALL && repoOf(card) !== filters.repo)
    return false;
  if (skip !== "workflow" && filters.workflow !== ALL) {
    const named = card.workflow || NO_WORKFLOW;
    if (named !== filters.workflow) return false;
  }
  return true;
}
