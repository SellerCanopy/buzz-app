import { useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { errorMessage } from "./engine/transport";
import type { InboxItem } from "./gen/kiln/engine/v1/engine_pb";
import { TextDialog, WITH_TEXT } from "./AnswerDialog";
import { artifactsOf, CHOICES, inboxKindLabel, subjectOf } from "./labels";

/**
 * One thing that waits for a person: the card it belongs to, what it waits for and a button for
 * each answer it takes. Reject and Reply ask for words first, and the button stays off until
 * there are some. Stop run asks first. Both questions are transient, so neither has a history
 * visit.
 */
export function GateCard({
  item,
  canRun,
  onOpenCard,
  onAnswer,
}: {
  item: InboxItem;
  canRun: boolean;
  onOpenCard(card: string): void;
  /** Sends the answer; it rejects with the engine's refusal. */
  onAnswer(item: InboxItem, choice: string, text: string): Promise<void>;
}) {
  const [asking, setAsking] = useState<string>();
  const [confirmStop, setConfirmStop] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const cancelStop = useRef<HTMLButtonElement>(null);
  const artifacts = artifactsOf(item.detailJson);

  /** Run one answer. On a refusal the words and the dialog stay, with the reason beside them. */
  const send = async (choice: string, text = "") => {
    if (pending) return false;
    setPending(true);
    setError(undefined);
    try {
      await onAnswer(item, choice, text);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setPending(false);
    }
  };

  const choose = (choice: string) => {
    if (WITH_TEXT.has(choice)) setAsking(choice);
    else if (choice === "stop") setConfirmStop(true);
    else void send(choice);
  };

  return (
    <section aria-label={`${inboxKindLabel(item.kind)}: ${item.cardTitle}`}>
      <InlineHeader
        title={item.cardTitle || "Card"}
        subtitle={item.title}
        eyebrow={`${inboxKindLabel(item.kind)}, stage ${item.stage}`}
        actions={
          <>
            <Button onClick={() => onOpenCard(item.cardId)}>Open card</Button>
            {canRun &&
              item.choices.map((choice) => (
                <Button
                  key={choice}
                  {...(CHOICES[choice]?.variant
                    ? { variant: CHOICES[choice].variant }
                    : {})}
                  disabled={pending}
                  onClick={() => choose(choice)}
                >
                  {CHOICES[choice]?.label ?? choice}
                </Button>
              ))}
          </>
        }
      />
      {artifacts.length > 0 && (
        <p className="text-body-sm text-subtle">
          {`To approve: ${artifacts.join(", ")}`}
        </p>
      )}
      {error && !asking && !confirmStop && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {asking && (
        <TextDialog
          kind={asking}
          subject={subjectOf(item.detailJson)}
          pending={pending}
          error={error}
          onClose={() => {
            setAsking(undefined);
            setError(undefined);
          }}
          onSubmit={async (text) => {
            if (await send(asking, text)) setAsking(undefined);
          }}
        />
      )}
      {confirmStop && (
        <AlertDialog
          title="Stop this run?"
          description="The run ends and the card moves to Stopped. What its stages already saved stays, and you can retry the run afterwards."
          pending={pending}
          initialFocus={cancelStop}
          onClose={() => {
            setConfirmStop(false);
            setError(undefined);
          }}
          actions={
            <>
              <Button
                ref={cancelStop}
                disabled={pending}
                onClick={() => setConfirmStop(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={pending}
                onClick={() =>
                  void send("stop").then(
                    (sent) => sent && setConfirmStop(false),
                  )
                }
              >
                Stop run
              </Button>
            </>
          }
        >
          {error && (
            <p role="alert" className="text-body text-danger">
              {error}
            </p>
          )}
        </AlertDialog>
      )}
    </section>
  );
}
