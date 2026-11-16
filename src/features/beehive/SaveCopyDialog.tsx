import { useState, type FormEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Switch } from "../../shared/design-system/ui/Switch";
import { NAME_RULE, WORKFLOW_NAME } from "./routes";

const FORM = "beehive-save-copy";

/**
 * Asks for the name of a copy of the draft being edited. The copy keeps only the stages unless
 * the person asks for the package's other files too. The original stays as it is.
 */
export function SaveCopyDialog({
  initialName,
  pending,
  error,
  onSave,
  onClose,
}: {
  initialName: string;
  pending: boolean;
  /** Why the last attempt failed, which the engine words. */
  error: string | undefined;
  onSave(name: string, keepFiles: boolean): void;
  onClose(): void;
}) {
  const [name, setName] = useState(initialName);
  const [keepFiles, setKeepFiles] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const trimmed = name.trim();
    if (!WORKFLOW_NAME.test(trimmed)) {
      setInvalid(true);
      return;
    }
    onSave(trimmed, keepFiles);
  };

  return (
    <Dialog
      open
      size="compact"
      title="Save as copy"
      description="Make a new workflow from this draft. The original stays as it is."
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
            Save copy
          </Button>
        </>
      }
    >
      <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
        <Field label="Name" error={invalid ? NAME_RULE : undefined}>
          <Input
            value={name}
            maxLength={32}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setInvalid(false);
            }}
          />
        </Field>
        <Switch
          label="Keep its files"
          checked={keepFiles}
          disabled={pending}
          onCheckedChange={setKeepFiles}
        />
        <p className="text-body-sm text-subtle">
          Copy the prompt and command files too.
        </p>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
