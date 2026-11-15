import { useState, type FormEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { Client } from "./engine/client";

const TITLE_MAX = 200;
const FORM = "beehive-new-card";

/** The form that adds a card. The board learns of the new card from the event log. */
export function NewCardDialog({
  client,
  onClose,
}: {
  client: Client;
  onClose(): void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [titleError, setTitleError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError("Enter a title for the card.");
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await client.createCard({
        title: trimmed,
        description,
        workflow: workflow.trim(),
      });
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The card could not be added. Try again.",
      );
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      size="compact"
      title="New card"
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
            variant="prominent"
            loading={pending}
            disabled={pending}
          >
            Add card
          </Button>
        </>
      }
    >
      <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
        <Field label="Title" error={titleError}>
          <Input
            value={title}
            maxLength={TITLE_MAX}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => {
              setTitle(event.target.value);
              setTitleError(undefined);
            }}
          />
        </Field>
        <Field label="Description" optional>
          <Textarea
            rows={4}
            value={description}
            disabled={pending}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field
          label="Workflow"
          optional
          description="Leave empty to put the card in Backlog."
        >
          <Input
            value={workflow}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => setWorkflow(event.target.value)}
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
