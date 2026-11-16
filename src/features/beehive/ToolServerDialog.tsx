import { useRef, useState, type FormEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type {
  AgentToolServer,
  AgentToolServers,
  AgentToolsChange,
} from "./gen/kiln/engine/v1/engine_pb";
import {
  check,
  formOf,
  keptNote,
  specFor,
  type Problems,
  type ToolServerForm,
  type Transport,
} from "./toolServer";

const FORM = "beehive-tool-server";

/**
 * Adds a tool server to an agent, or edits one. A server is saved whole: the engine replaces
 * the entry of that name, so an edit is the same call as an add. The name of a saved server is
 * fixed, because it is the key of the entry. The form has no place for a secret; the engine
 * refuses one too. Saving writes the agent's files and may restart it, which the dialog says
 * before it is saved.
 */
export function ToolServerDialog({
  client,
  agents,
  editing,
  onClose,
  onSaved,
}: {
  client: Client;
  agents: readonly AgentToolServers[];
  /** The server being edited and the agent that has it, or none to add one. */
  editing?: { agent: string; server: AgentToolServer } | undefined;
  onClose(): void;
  onSaved(agent: string, name: string, change: AgentToolsChange): void;
}) {
  const name = useRef<HTMLInputElement>(null);
  const value = useRef<HTMLInputElement>(null);
  const [agent, setAgent] = useState(editing?.agent ?? agents[0]?.agent ?? "");
  const [form, setForm] = useState<ToolServerForm>(
    editing
      ? formOf(editing.server)
      : { name: "", transport: "stdio", command: "", url: "" },
  );
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const isNew = !editing;
  const set = <K extends keyof ToolServerForm>(
    key: K,
    next: ToolServerForm[K],
  ) => {
    setForm((was) => ({ ...was, [key]: next }));
    // A new transport shows other fields, so what was said about the old ones no longer applies.
    setProblems((was) =>
      key === "transport" ? {} : { ...was, [key]: undefined },
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const taken =
      agents
        .find((entry) => entry.agent === agent)
        ?.servers.map((s) => s.name) ?? [];
    const found = check(form, taken, isNew);
    setProblems(found);
    if (Object.values(found).some(Boolean)) return;
    setError(undefined);
    setPending(true);
    try {
      const saved = form.name.trim();
      onSaved(
        agent,
        saved,
        await client.setAgentToolServer(agent, {
          name: saved,
          transport: form.transport,
          spec: specFor(form, editing?.server),
        }),
      );
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  const note = keptNote(editing?.server, form.transport);
  return (
    <Dialog
      open
      size="compact"
      title={editing ? `Edit ${editing.server.name}` : "Add tool server"}
      description="Saving writes the agent's tool list. If it changed, the agent restarts, and a restarted agent restarts the work it is doing now."
      initialFocus={isNew ? name : value}
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
            Save server
          </Button>
        </>
      }
    >
      <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
        <Select
          label="Agent"
          variant="field"
          value={agent}
          disabled={pending || !isNew}
          onValueChange={setAgent}
          groups={[
            {
              label: "Agents",
              options: agents.map((entry) => ({
                value: entry.agent,
                label: entry.agent,
              })),
            },
          ]}
        />
        <Field
          label="Name"
          description={
            isNew
              ? undefined
              : "The name cannot change. Remove the server and add it again to rename it."
          }
          error={problems.name}
        >
          <Input
            ref={name}
            value={form.name}
            disabled={pending || !isNew}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>
        <Select
          label="Transport"
          variant="field"
          value={form.transport}
          disabled={pending}
          onValueChange={(next) => set("transport", next as Transport)}
          groups={[
            {
              label: "Transport",
              options: [
                { value: "stdio", label: "Command (stdio)" },
                { value: "http", label: "Hosted server (http)" },
              ],
            },
          ]}
        />
        {form.transport === "stdio" ? (
          <Field
            label="Command and arguments"
            description="Quote an argument that holds spaces."
            error={problems.command}
          >
            <Input
              ref={value}
              value={form.command}
              placeholder="npx docs-server --stdio"
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set("command", event.target.value)}
            />
          </Field>
        ) : (
          <Field label="Address" error={problems.url}>
            <Input
              ref={value}
              value={form.url}
              placeholder="https://example.org/mcp"
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set("url", event.target.value)}
            />
          </Field>
        )}
        {note && <p className="text-body-sm text-subtle">{note}</p>}
        <p className="text-body-sm text-subtle">
          Leave keys and tokens out. A tool server cannot hold a secret yet;
          secrets come in a later phase.
        </p>
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
