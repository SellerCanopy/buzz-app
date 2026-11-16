import { useRef, useState, type FormEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";

const FORM = "beehive-reject";

/**
 * Asks for the reason an approval is sent back with. The submit button waits for some words.
 * `subject` names what is rejected, as `plan`. The dialog is a transient surface, so it has no
 * history visit.
 */
export function RejectDialog({
  subject = "",
  pending,
  error,
  onClose,
  onSubmit,
}: {
  subject?: string;
  pending: boolean;
  error: string | undefined;
  onClose(): void;
  onSubmit(text: string): Promise<void>;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !pending) void onSubmit(text.trim());
  };
  return (
    <Dialog
      open
      size="compact"
      title={subject ? `Reject the ${subject}` : "Reject"}
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
            Reject
          </Button>
        </>
      }
    >
      <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
        <Field
          label="Reason"
          description="Say what to change. The agent reads your reason on the next try."
        >
          <Textarea
            ref={field}
            rows={4}
            value={text}
            placeholder="Add a rollback step and split the scan from the review hand-off."
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
