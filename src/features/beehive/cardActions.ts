import type { Card, Run } from "./gen/kiln/engine/v1/engine_pb";

/** A card with a workflow and no run in flight can start one. */
export function canStart(card: Card): boolean {
  return !card.archived && !!card.workflow && card.state === "idle";
}

/** A run that has not ended can be stopped. */
export function canStop(run: Run): boolean {
  return run.state !== "ended";
}

/** A run that is working can be held, and resumed afterwards. */
export function canPause(card: Card, run: Run | undefined): run is Run {
  return !!run && !card.archived && run.state === "running";
}

/** A card whose run failed or was stopped can start again from the stage it reached. */
export function canRetry(card: Card, run: Run | undefined): run is Run {
  return (
    !!run &&
    !card.archived &&
    run.state === "ended" &&
    (card.state === "failed" || card.state === "stopped")
  );
}

/**
 * A card whose pull request is open, out of draft and not failing or waiting on checks can be
 * merged. The engine reads the host again and refuses what it finds not ready, so this only
 * keeps the button off a card that plainly cannot be merged.
 */
export function canMerge(card: Card): boolean {
  const pull = card.pullRequest;
  return (
    !card.archived &&
    !!pull &&
    pull.state === "open" &&
    !pull.draft &&
    pull.checks !== "failing" &&
    pull.checks !== "pending"
  );
}

/** An address is shown as a link only when it is a web address. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
