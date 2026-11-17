import { useRef } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

/** What a card page asks a person to confirm first. */
export type Confirm = "stop" | "skip" | "merge" | "reset" | "remove";

const COPY: Record<
  Confirm,
  {
    title: string;
    description: string;
    action: string;
    variant: "prominent" | "destructive";
  }
> = {
  stop: {
    title: "Stop this run?",
    description:
      "The run ends and the card moves to Stopped. What its stages already saved stays, and you can retry the run afterwards.",
    action: "Stop run",
    variant: "destructive",
  },
  skip: {
    title: "Skip this stage?",
    description:
      "The card moves on as if the stage had passed, and the stage is marked skipped. Nothing the stage would have done is run.",
    action: "Skip stage",
    variant: "prominent",
  },
  merge: {
    title: "Merge the pull request?",
    description:
      "Beehive checks the pull request once more and merges it. Then it moves the card to the last lane of its view.",
    action: "Merge the pull request",
    variant: "prominent",
  },
  reset: {
    title: "Reset this card?",
    description:
      "Reset stops the card's run, closes its pull request, removes its worktree and moves it back to the first lane. Its artifacts and branch are kept.",
    action: "Reset card",
    variant: "destructive",
  },
  remove: {
    title: "Remove this card?",
    description:
      "This takes the card off the board for good. A card whose run is working must be stopped first.",
    action: "Remove card",
    variant: "destructive",
  },
};

/**
 * Asks before a card page acts on the card as a whole. Cancel has the first focus, and the
 * question is a transient surface, so it has no history visit.
 */
export function CardConfirm({
  kind,
  pending,
  onCancel,
  onConfirm,
}: {
  kind: Confirm;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const copy = COPY[kind];
  return (
    <AlertDialog
      title={copy.title}
      description={copy.description}
      pending={pending}
      initialFocus={cancel}
      onClose={onCancel}
      actions={
        <>
          <Button ref={cancel} disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={copy.variant} loading={pending} onClick={onConfirm}>
            {copy.action}
          </Button>
        </>
      }
    />
  );
}
