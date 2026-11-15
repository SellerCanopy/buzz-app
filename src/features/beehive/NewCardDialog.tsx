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

type Mode = "write" | "issue";

/**
 * The form that adds a card, written out or made from an open issue of a repo the team's
 * GitHub connection reaches. The board learns of the new card from the event log.
 */
export function NewCardDialog({
  client,
  onClose,
}: {
  client: Client;
  onClose(): void;
}) {
  const [mode, setMode] = useState<Mode>("write");
  const [picked, setPicked] = useState<PickedIssue>();
  const [pickError, setPickError] = useState<string>();
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
    if (mode === "write" && !trimmed) {
      setTitleError("Enter a title for the card.");
      return;
    }
    if (mode === "issue" && !picked) {
      setPickError("Choose an issue.");
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await client.createCard(
        mode === "issue" && picked
          ? { issue: picked, workflow: workflow.trim() }
          : { title: trimmed, description, workflow: workflow.trim() },
      );
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
            { value: "write", label: "Write one", disabled: pending },
            { value: "issue", label: "From an issue", disabled: pending },
          ]}
        />
        {mode === "write" && (
          <>
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
          </>
        )}
        {mode === "issue" && (
          <>
            <IssuePicker
              client={client}
              disabled={pending}
              picked={picked}
              onPick={(issue) => {
                setPicked(issue);
                setPickError(undefined);
              }}
            />
            {pickError && (
              <p role="alert" className="text-body text-danger">
                {pickError}
              </p>
            )}
          </>
        )}
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
