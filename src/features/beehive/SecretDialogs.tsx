import { useRef, useState, type FormEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { SecretChange } from "./gen/kiln/engine/v1/engine_pb";
import { NO_READ_BACK, checkName, checkRoom, checkValue } from "./secret";

const FORM = "beehive-secret";
const RESTART =
  "Agents that get the change restart, and a restarted agent restarts the work it is doing now.";

type Problems = { name?: string | undefined; value?: string | undefined };

/**
 * Sets a team secret, or one agent's own, or replaces one. The value is write only: the field is
 * uncontrolled, so it lives in the input and nowhere in React state, and it is emptied the moment
 * it is read for sending, whether the save then works or fails. It is never shown, and no
 * message here repeats it.
 */
export function SecretDialog({
  client,
  agent,
  replacing,
  holds,
  own,
  onClose,
  onSaved,
}: {
  client: Client;
  /** The agent whose own secret this is, or none for a team secret. */
  agent?: string | undefined;
  /** The name of the secret being replaced, or none to add one. */
  replacing?: string | undefined;
  /** How many secrets the agent holds, own and granted, for the limit. Unused for a team secret. */
  holds?: number | undefined;
  /** The names of the agent's own secrets: setting one of these replaces it, so it needs no room. */
  own?: readonly string[] | undefined;
  onClose(): void;
  onSaved(name: string, change: SecretChange): void;
}) {
  const nameInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(replacing ?? "");
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const isNew = replacing === undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const field = valueInput.current;
    const secret = field?.value ?? "";
    const saved = (replacing ?? name).trim();
    const found: Problems = {
      name:
        (isNew ? checkName(saved) : undefined) ??
        (isNew && agent !== undefined && !own?.includes(saved)
          ? checkRoom(holds ?? 0)
          : undefined),
      value: checkValue(secret),
    };
    setProblems(found);
    if (found.name || found.value) return;
    // The value leaves the field now, so a failure does not leave it on screen.
    if (field) field.value = "";
    setError(undefined);
    setPending(true);
    try {
      onSaved(
        saved,
        agent === undefined
          ? await client.setTeamSecret(saved, secret)
          : await client.setAgentSecret(agent, saved, secret),
      );
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  const what = agent === undefined ? "team secret" : `secret for ${agent}`;
  return (
    <Dialog
      open
      size="compact"
      title={isNew ? `Add ${what}` : `Replace ${replacing}`}
      description={`${NO_READ_BACK} ${RESTART}`}
      initialFocus={isNew ? nameInput : valueInput}
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
            Save secret
          </Button>
        </>
      }
    >
      <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
        <Field
          label="Name"
          description={
            isNew
              ? "Capital letters, digits and _. It becomes an environment variable. Using the name of an existing secret replaces its value."
              : "The name cannot change."
          }
          error={problems.name}
        >
          <Input
            ref={nameInput}
            value={name}
            disabled={pending || !isNew}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setName(event.target.value);
              setProblems((was) => ({ ...was, name: undefined }));
            }}
          />
        </Field>
        <Field
          label="Value"
          description={
            agent === undefined
              ? undefined
              : "This agent's own secret wins over a team secret of the same name."
          }
          error={problems.value}
        >
          <Input
            ref={valueInput}
            type="password"
            defaultValue=""
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
            onChange={() =>
              setProblems((was) => ({ ...was, value: undefined }))
            }
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

/** Gives an agent one of the team secrets it does not hold yet. */
export function GrantDialog({
  client,
  agent,
  names,
  holds,
  onClose,
  onSaved,
}: {
  client: Client;
  agent: string;
  /** The team secrets the agent does not hold. */
  names: readonly string[];
  /** How many secrets the agent holds, for the limit. */
  holds: number;
  onClose(): void;
  onSaved(name: string, change: SecretChange): void;
}) {
  const [name, setName] = useState(names[0] ?? "");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const room = checkRoom(holds);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || room) return;
    setError(undefined);
    setPending(true);
    try {
      onSaved(name, await client.grantTeamSecret(agent, name));
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      size="compact"
      title={`Give ${agent} a team secret`}
      description={`The agent gets the secret in its environment and cannot read it back out of Beehive. ${RESTART}`}
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
            form={`${FORM}-grant`}
            variant="prominent"
            loading={pending}
            disabled={pending || Boolean(room) || !name}
          >
            Give secret
          </Button>
        </>
      }
    >
      <form
        id={`${FORM}-grant`}
        onSubmit={submit}
        noValidate
        className="beehive-form"
      >
        <Select
          label="Team secret"
          variant="field"
          value={name}
          disabled={pending}
          onValueChange={setName}
          groups={[
            {
              label: "Team secrets",
              options: names.map((value) => ({ value, label: value })),
            },
          ]}
        />
        {room && <p className="text-body-sm text-danger">{room}</p>}
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
