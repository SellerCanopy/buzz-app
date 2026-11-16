import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { isWebUrl } from "./cardActions";
import type { Client } from "./engine/client";
import { EngineError, errorMessage } from "./engine/transport";

const FORM = "beehive-agent-login";

type Step =
  | { kind: "starting" }
  | { kind: "link"; url: string }
  /** The sign-in cannot go on from here, so the only way forward is to start it again. */
  | { kind: "gone"; message: string };

/**
 * Signs an agent in to one of its hosted tool servers. Opening it starts the sign-in: the host
 * runs the CLI's login and returns a link, the person opens it, signs in, and pastes back the
 * address their browser ends on. The link and that address can carry the sign-in itself, so
 * they live only in this dialog: the address field is uncontrolled and is emptied the moment it
 * is read for sending, whether the paste then works or not, and no message here repeats either.
 * An address with the wrong shape is refused and the sign-in keeps waiting; any other failure
 * (it expired after ten minutes, or the host is not set up for this) ends it, and Connect
 * again starts a new one.
 */
export function AgentLoginDialog({
  client,
  agent,
  server,
  onClose,
  onSignedIn,
}: {
  client: Client;
  agent: string;
  server: string;
  onClose(): void;
  /** The sign-in finished. `state` is what the host then reported for the server. */
  onSignedIn(state: string): void;
}) {
  const address = useRef<HTMLInputElement>(null);
  const alive = useRef(false);
  const started = useRef(false);
  const [step, setStep] = useState<Step>({ kind: "starting" });
  const [problem, setProblem] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const connect = useCallback(async () => {
    setStep({ kind: "starting" });
    setProblem(undefined);
    setError(undefined);
    try {
      const { url } = await client.startAgentLogin(agent, server);
      if (!alive.current) return;
      setStep(
        isWebUrl(url)
          ? { kind: "link", url }
          : {
              kind: "gone",
              message: "Beehive did not send a link that can be opened.",
            },
      );
    } catch (failure) {
      if (alive.current)
        setStep({ kind: "gone", message: errorMessage(failure) });
    }
  }, [client, agent, server]);

  useEffect(() => {
    alive.current = true;
    // Starting is one call that replaces any sign-in already waiting, so it runs once.
    if (!started.current) {
      started.current = true;
      void connect();
    }
    return () => {
      alive.current = false;
    };
  }, [connect]);

  const waiting = step.kind === "link";
  useEffect(() => {
    if (waiting) address.current?.focus();
  }, [waiting]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || step.kind !== "link") return;
    const field = address.current;
    const pasted = field?.value ?? "";
    if (!pasted.trim()) {
      setProblem("Paste the address your browser ended on.");
      return;
    }
    // The address leaves the field now, so neither a failure nor a wait leaves it on screen.
    if (field) field.value = "";
    setProblem(undefined);
    setError(undefined);
    setPending(true);
    try {
      const reply = await client.pasteAgentLogin(agent, server, pasted);
      if (!alive.current) return;
      if (!reply.signedIn) {
        setStep({
          kind: "gone",
          message: "The sign-in did not finish. Connect again.",
        });
        return;
      }
      let state = "connected";
      try {
        state = (await client.getAgentLoginStatus(agent, server)).state;
      } catch {
        // The paste worked; the row shows that until the next read says otherwise.
      }
      if (alive.current) onSignedIn(state);
    } catch (failure) {
      if (!alive.current) return;
      const message = errorMessage(failure);
      // Only a refused address leaves the sign-in waiting. The host can also refuse an address
      // it did accept in shape; its message then says to start again, and Connect again does.
      if (failure instanceof EngineError && failure.code === "invalid_argument")
        setError(message);
      else setStep({ kind: "gone", message });
    } finally {
      if (alive.current) setPending(false);
    }
  };

  return (
    <Dialog
      open
      size="compact"
      title={`Connect ${server} on ${agent}`}
      description="Signs the agent in to this tool server. The link and the address you paste are used once and are not kept."
      initialFocus={address}
      dismissOnOutsideClick={false}
      preventClose={pending}
      onOpenChange={(open) => !open && onClose()}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          {step.kind === "link" && (
            <Button
              type="submit"
              form={FORM}
              variant="prominent"
              loading={pending}
              disabled={pending}
            >
              Paste address
            </Button>
          )}
          {step.kind === "gone" && (
            <Button variant="prominent" onClick={() => void connect()}>
              Connect again
            </Button>
          )}
        </>
      }
    >
      {step.kind === "starting" && (
        <p role="status" className="text-body-sm text-subtle">
          Starting the sign-in…
        </p>
      )}
      {step.kind === "gone" && (
        <p role="alert" className="text-body text-danger">
          {step.message}
        </p>
      )}
      {step.kind === "link" && (
        <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
          <p className="text-body">
            Open this link, sign in, then paste the address your browser ends
            on.{" "}
            <Button
              variant="link"
              size="text"
              role="link"
              nativeButton={false}
              render={
                <a href={step.url} target="_blank" rel="noopener noreferrer" />
              }
            >
              Open the sign-in link
            </Button>
          </p>
          <Field
            label="Address"
            error={problem}
            description="The page it ends on may say it cannot connect. That is expected: copy the address from the address bar."
          >
            <Input
              ref={address}
              type="text"
              defaultValue=""
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              placeholder="http://localhost:…"
              onChange={() => {
                setProblem(undefined);
                setError(undefined);
              }}
            />
          </Field>
          {error && (
            <p role="alert" className="text-body text-danger">
              {error}{" "}
              <Button
                size="inline"
                variant="link"
                disabled={pending}
                onClick={() => void connect()}
              >
                Connect again
              </Button>
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
