import { useState, type FormEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { Client } from "./engine/client";
import { IssuePicker, type PickedIssue } from "./IssuePicker";

const TITLE_MAX = 200;
const FORM = "beehive-new-card";

type Mode = "blank" | "issue";

const SUBTITLES: Record<Mode, string> = {
  blank: "Cards wait in Backlog until you pick a workflow.",
  issue:
    "Search issues, then take one. The card keeps its title, text and comments.",
};

/**
 * The form that adds a card, written out or taken from an issue of a repo the team's GitHub
 * connection reaches. The board learns of the new card from the event log.
 */
export function NewCardDialog({
  client,
  initial = "blank",
  onClose,
}: {
  client: Client;
  /** The tab the form opens on. */
  initial?: Mode;
  onClose(): void;
}) {
  const [mode, setMode] = useState<Mode>(initial);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [titleError, setTitleError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  /** Makes the card. A failure keeps the form, and what was typed, with the engine's words. */
  const create = async (input: Parameters<Client["createCard"]>[0]) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await client.createCard(input);
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError("Enter a title for the card.");
      return;
    }
    void create({ title: trimmed, description, workflow: workflow.trim() });
  };
  const take = (issue: PickedIssue) => void create({ issue });

  return (
    <Dialog
      open
      size="compact"
      title="New card"
      description={SUBTITLES[mode]}
      dismissOnOutsideClick={false}
      preventClose={pending}
      onOpenChange={(open) => !open && onClose()}
      actions={
        mode === "blank" ? (
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
        ) : (
          <Button disabled={pending} onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="beehive-form">
        <Tabs
          variant="segmented"
          size="sm"
          label="Where the card comes from"
          value={mode}
          onValueChange={(next) => {
            setMode(next);
            setError(undefined);
          }}
          items={[
            { value: "blank", label: "Blank card", disabled: pending },
            { value: "issue", label: "From an issue", disabled: pending },
          ]}
        />
        {mode === "blank" && (
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
          </form>
        )}
        {mode === "issue" && (
          <IssuePicker client={client} disabled={pending} onTake={take} />
        )}
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
