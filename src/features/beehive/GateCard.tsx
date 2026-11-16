import { useRef, useState, type FormEvent } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { errorMessage } from "./engine/transport";
import type { InboxItem } from "./gen/kiln/engine/v1/engine_pb";
import { RejectDialog } from "./RejectDialog";
import {
  artifactsOf,
  CHOICES,
  choiceLabel,
  inboxKindLabel,
  subjectOf,
  waitedLabel,
} from "./labels";

/**
 * One thing that waits for a person: the card it belongs to, what it waits for and a button for
 * each answer it takes. Reject asks for a reason in a dialog, and a question's reply is typed
 * in the card itself; the button for either stays off until there are words. Stop run asks
 * first. Both questions are transient, so neither has a history visit.
 */
export function GateCard({
  item,
  workflow = "",
  now = Date.now(),
  canRun,
  onOpenCard,
  onAnswer,
}: {
  item: InboxItem;
  /** The card's workflow, when it is known. */
  workflow?: string;
  /** The moment waiting is counted to, in milliseconds. */
  now?: number;
  canRun: boolean;
  onOpenCard(card: string): void;
  /** Sends the answer; it rejects with the engine's refusal. */
  onAnswer(item: InboxItem, choice: string, text: string): Promise<void>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [reply, setReply] = useState("");
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

  const replies = item.choices.includes("reply");
  const sendReply = async (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (!text) return;
    // On a refusal the words stay, with the reason under them.
    if (await send("reply", text)) setReply("");
  };

  const choose = (choice: string) => {
    if (choice === "reject") setRejecting(true);
    else if (choice === "stop") setConfirmStop(true);
    else void send(choice);
  };

  return (
    <section aria-label={`${inboxKindLabel(item.kind)}: ${item.cardTitle}`}>
      <InlineHeader
        title={item.cardTitle || "Card"}
        // With nothing listed, the engine's "waits for approval of" has nothing after it.
        subtitle={
          item.kind === "approval" && artifacts.length === 0
            ? item.title.replace(/\s+of$/, "")
            : item.title
        }
        eyebrow={[
          `${inboxKindLabel(item.kind)}, stage ${item.stage}`,
          workflow,
          waitedLabel(item.createdAt, now),
        ]
          .filter(Boolean)
          .join(", ")}
        actions={
          <>
            <Button variant="ghost" onClick={() => onOpenCard(item.cardId)}>
              Open card
            </Button>
            {canRun &&
              item.choices
                // A question's reply has its own field and button below.
                .filter((choice) => choice !== "reply")
                // Reject sits before Approve, as the quieter answer before the prominent one.
                .sort((a, b) => Number(b === "reject") - Number(a === "reject"))
                .map((choice) => (
                  <Button
                    key={choice}
                    {...(CHOICES[choice]?.variant
                      ? { variant: CHOICES[choice].variant }
                      : {})}
                    disabled={pending}
                    onClick={() => choose(choice)}
                  >
                    {choiceLabel(item.kind, choice)}
                  </Button>
                ))}
          </>
        }
      />
      {artifacts.length > 0 && (
        <p>
          <span className="beehive-chip text-body-sm">
            {`To approve: ${artifacts.join(", ")}`}
          </span>
        </p>
      )}
      {canRun && replies && (
        <form onSubmit={sendReply} noValidate className="beehive-form">
          <Field label="Your answer">
            <Textarea
              rows={3}
              value={reply}
              placeholder="Add a note"
              disabled={pending}
              onChange={(event) => setReply(event.target.value)}
            />
          </Field>
          <div>
            <Button
              type="submit"
              variant="prominent"
              disabled={!reply.trim() || pending}
            >
              Send answer
            </Button>
          </div>
        </form>
      )}
      {error && !rejecting && !confirmStop && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {rejecting && (
        <RejectDialog
          subject={subjectOf(item.detailJson)}
          pending={pending}
          error={error}
          onClose={() => {
            setRejecting(false);
            setError(undefined);
          }}
          onSubmit={async (text) => {
            if (await send("reject", text)) setRejecting(false);
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
