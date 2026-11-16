import { useRef, useState, type FormEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";

/** The answers that ask for words in a dialog: a reason for sending an approval back. */
export const WITH_TEXT = new Set(["reject"]);

const FORM = "beehive-answer";

/** The words of the dialog, and how its submit button looks. */
function copyOf(subject: string) {
  return {
    title: subject ? `Reject the ${subject}` : "Reject",
    action: "Reject",
    label: "Reason",
    help: "Say what to change. The agent reads your reason on the next try.",
    placeholder:
      "Add a rollback step and split the scan from the review hand-off.",
  };
}

/**
 * Asks for the reason an approval is sent back with. The submit button waits for some words.
 * `subject` names what is rejected, as `plan`. The dialog is a transient surface, so it has no
 * history visit.
 */
export function TextDialog({
  kind,
  subject = "",
  pending,
  error,
  onClose,
  onSubmit,
}: {
  kind: string;
  subject?: string;
  pending: boolean;
  error: string | undefined;
  onClose(): void;
  onSubmit(text: string): Promise<void>;
}) {
  const copy = copyOf(subject);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !pending) void onSubmit(text.trim());
  };
  if (!WITH_TEXT.has(kind)) return null;
  return (
    <Dialog
      open
      size="compact"
      title={copy.title}
      initialFocus={field}
      dismissOnOutsideClick={false}
      preventClose={pending}
      onOpenChange={(open) => !open && onClose()}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM}
            variant="destructive"
            loading={pending}
            disabled={!ready || pending}
          >
            {copy.action}
          </Button>
        </>
      }
    >
      <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
        <Field label={copy.label} description={copy.help}>
          <Textarea
            ref={field}
            rows={4}
            value={text}
            placeholder={copy.placeholder}
            disabled={pending}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
