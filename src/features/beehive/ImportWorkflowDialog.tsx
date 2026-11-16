import { useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";

/**
 * Adds the workflow in a zip that Export wrote. The zip names the package, and a name that is
 * already taken is refused. Choosing the file imports it.
 */
export function ImportWorkflowDialog({
  client,
  onImported,
  onClose,
}: {
  client: Client;
  onImported(name: string): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const choose = async (file: File | undefined) => {
    if (!file || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const imported = await client.importWorkflow(bytes);
      onImported(imported.name);
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      size="compact"
      title="Import a workflow"
      description="Choose where the workflow comes from."
      dismissOnOutsideClick={false}
      preventClose={pending}
      onOpenChange={(open) => !open && onClose()}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={pending}
            onClick={() => input.current?.click()}
          >
            Choose a file
          </Button>
        </>
      }
    >
      <div className="beehive-form">
        <p className="text-label">Workflow zip</p>
        <p className="text-body-sm text-subtle">
          A .zip that Export wrote, with the workflow and its files.
        </p>
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          aria-label="Workflow zip"
          tabIndex={-1}
          onChange={(event) => {
            void choose(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
