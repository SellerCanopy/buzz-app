import type { Card } from "./gen/kiln/engine/v1/engine_pb";

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
