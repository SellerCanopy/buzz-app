import { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Callout } from "./Callout";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type {
  ListSecretNamesResponse,
  SecretChange,
} from "./gen/kiln/engine/v1/engine_pb";
import { GrantDialog, SecretDialog } from "./SecretDialogs";
import {
  NO_READ_BACK,
  appliedLine,
  list,
  reached,
  type Reached,
} from "./secret";

type Loaded =
  | { status: "loading" }
  | {
      status: "ready";
      names: ListSecretNamesResponse;
      /** Every agent that has a folder on the host. */
      agents: readonly string[];
    }
  | { status: "error"; message: string };

type Setting = { agent?: string; replacing?: string };

/**
 * The secrets agents run with, by name. Only an admin sees it. A secret is written and never
 * read: the engine keeps no value, so a value cannot be shown, only replaced. A team secret
 * reaches an agent only when it is granted to that agent, and an agent's own secret wins over a
 * team secret of the same name. A change is saved first and applied second, and the engine says
 * which agents got it, which restarted, and which did not get it with the host's reason.
 */
export function SecretsSettings({ client }: { client: Client }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** The list could not be read again after a change that was saved. */
  const [stale, setStale] = useState<string>();
  const [setting, setSetting] = useState<Setting>();
  const [granting, setGranting] = useState<string>();
  const [revoking, setRevoking] = useState<{ agent: string; name: string }>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [outcome, setOutcome] = useState<Reached>();
  const cancelRevoke = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    // A read after a change keeps the list on screen until the new one arrives.
    setLoaded((was) => (was.status === "ready" ? was : { status: "loading" }));
    Promise.all([
      client.listSecretNames(abort.signal),
      client.listAgentToolServers(abort.signal),
    ])
      .then(([names, folders]) => {
        if (abort.signal.aborted) return;
        setStale(undefined);
        setLoaded({
          status: "ready",
          names,
          agents: folders.agents.map((entry) => entry.agent),
        });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const message = errorMessage(error);
        setLoaded((was) =>
          was.status === "ready" ? was : { status: "error", message },
        );
        setStale(message);
      });
    return () => abort.abort();
  }, [client, attempt]);

  const changed = (done: string, change: SecretChange) => {
    setOutcome(reached(done, change.applied));
    reload();
  };

  const revoke = async ({ agent, name }: { agent: string; name: string }) => {
    if (pending) return;
    setPending(true);
    setFailure(undefined);
    try {
      changed(
        `Revoked ${name} from ${agent}.`,
        await client.revokeTeamSecret(agent, name),
      );
      setRevoking(undefined);
      requestAnimationFrame(() => addButton.current?.focus());
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  const ready = loaded.status === "ready" ? loaded : undefined;
  const team = ready?.names.team ?? [];
  const grants = ready?.names.grants ?? [];
  const own = (agent: string) =>
    (ready?.names.agents ?? []).flatMap((entry) =>
      entry.agent === agent && entry.secret ? [entry.secret.name] : [],
    );
  const granted = (agent: string) =>
    grants.filter((grant) => grant.agent === agent).map((grant) => grant.name);
  const grantedTo = (name: string) =>
    grants.filter((grant) => grant.name === name).map((grant) => grant.agent);

  return (
    <>
      <InlineHeader
        title="Secrets"
        subtitle={`Keys and tokens agents run with. ${NO_READ_BACK}`}
        actions={
          <Button
            ref={addButton}
            disabled={!ready || pending}
            onClick={() => setSetting({})}
          >
            Add team secret
          </Button>
        }
      />
      {outcome && <Applied change={outcome} />}
      {stale && ready && (
        <p role="status" className="text-body-sm text-subtle">
          {`Could not read the secrets again. ${stale} `}
          <Button size="inline" variant="link" onClick={reload}>
            Check again
          </Button>
        </p>
      )}
      <LoadingRegion
        pending={loaded.status === "loading"}
        label="Loading secrets…"
        feedback={
          loaded.status === "error" ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {loaded.message}
              </p>
              <Button onClick={reload}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {ready && (
          <section aria-label="Team secrets">
            <InlineHeader level={4} title="Team secrets" />
            {team.length === 0 ? (
              <p className="text-body-sm text-subtle">
                No team secrets yet. An agent gets one only when it is granted
                to that agent.
              </p>
            ) : (
              <SettingsGroup>
                {team.map((secret) => {
                  const holders = grantedTo(secret.name);
                  return (
                    <PreferenceRow
                      key={secret.name}
                      title={secret.name}
                      subtitle={
                        holders.length > 0
                          ? `Granted to ${list(holders)}.`
                          : "Not granted to any agent."
                      }
                      trailing={
                        <Button
                          size="sm"
                          aria-label={`Replace ${secret.name}`}
                          disabled={pending}
                          onClick={() => setSetting({ replacing: secret.name })}
                        >
                          Replace
                        </Button>
                      }
                    />
                  );
                })}
              </SettingsGroup>
            )}
          </section>
        )}
        {ready?.agents.map((agent) => {
          const ownNames = own(agent);
          const teamNames = granted(agent);
          const available = team
            .map((secret) => secret.name)
            .filter((name) => !teamNames.includes(name));
          return (
            <section key={agent} aria-label={`Secrets of ${agent}`}>
              <InlineHeader level={4} title={agent} />
              <div className="beehive-agent-actions">
                <Button
                  size="sm"
                  aria-label={`Give ${agent} a team secret`}
                  disabled={available.length === 0 || pending}
                  onClick={() => setGranting(agent)}
                >
                  Give team secret
                </Button>
                <Button
                  size="sm"
                  aria-label={`Add a secret for ${agent}`}
                  disabled={pending}
                  onClick={() => setSetting({ agent })}
                >
                  Add own secret
                </Button>
              </div>
              {ownNames.length + teamNames.length === 0 ? (
                <p className="text-body-sm text-subtle">No secrets.</p>
              ) : (
                <SettingsGroup>
                  {ownNames.map((name) => (
                    <PreferenceRow
                      key={`own-${name}`}
                      title={name}
                      subtitle="Its own secret. It wins over a team secret of the same name."
                      trailing={
                        <Button
                          size="sm"
                          aria-label={`Replace ${name} on ${agent}`}
                          disabled={pending}
                          onClick={() => setSetting({ agent, replacing: name })}
                        >
                          Replace
                        </Button>
                      }
                    />
                  ))}
                  {teamNames.map((name) => (
                    <PreferenceRow
                      key={`team-${name}`}
                      title={name}
                      subtitle={
                        ownNames.includes(name)
                          ? "Team secret, hidden by its own secret of the same name."
                          : "Team secret granted to this agent."
                      }
                      trailing={
                        <Button
                          size="sm"
                          aria-label={`Revoke ${name} from ${agent}`}
                          disabled={pending}
                          onClick={() => {
                            setFailure(undefined);
                            setRevoking({ agent, name });
                          }}
                        >
                          Revoke
                        </Button>
                      }
                    />
                  ))}
                </SettingsGroup>
              )}
            </section>
          );
        })}
      </LoadingRegion>
      {setting && (
        <SecretDialog
          client={client}
          agent={setting.agent}
          replacing={setting.replacing}
          holds={
            setting.agent === undefined
              ? undefined
              : own(setting.agent).length + granted(setting.agent).length
          }
          own={setting.agent === undefined ? undefined : own(setting.agent)}
          onClose={() => setSetting(undefined)}
          onSaved={(name, change) => {
            setSetting(undefined);
            changed(`Saved ${name}.`, change);
          }}
        />
      )}
      {granting && ready && (
        <GrantDialog
          client={client}
          agent={granting}
          names={team
            .map((secret) => secret.name)
            .filter((name) => !granted(granting).includes(name))}
          holds={own(granting).length + granted(granting).length}
          onClose={() => setGranting(undefined)}
          onSaved={(name, change) => {
            setGranting(undefined);
            changed(`Gave ${name} to ${granting}.`, change);
          }}
        />
      )}
      {revoking && (
        <AlertDialog
          title={`Revoke ${revoking.name} from ${revoking.agent}?`}
          description="The agent loses this secret. The value stays for the agents that still hold it. If the agent's environment changes, it restarts, and a restarted agent restarts the work it is doing now."
          pending={pending}
          initialFocus={cancelRevoke}
          onClose={() => setRevoking(undefined)}
          actions={
            <>
              <Button
                ref={cancelRevoke}
                disabled={pending}
                onClick={() => setRevoking(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={pending}
                onClick={() => void revoke(revoking)}
              >
                Revoke secret
              </Button>
            </>
          }
        >
          {failure && (
            <p role="alert" className="text-body text-danger">
              {failure}
            </p>
          )}
        </AlertDialog>
      )}
    </>
  );
}

/** What the engine said happened to each agent after a change. */
function Applied({ change }: { change: Reached }) {
  const { failed } = change;
  const heard = change.restarted.length + change.unchanged.length > 0;
  return (
    <>
      {(heard || failed.length === 0) && (
        <p role="status" className="text-body">
          {appliedLine(change)}
        </p>
      )}
      {failed.length > 0 && (
        <Callout
          tone="warning"
          title={`Saved, but ${list(failed.map((f) => f.agent))} ${failed.length > 1 ? "do" : "does"} not have the change yet`}
        >
          <span role="alert">
            {failed.map((f) => `${f.agent}: ${f.reason}`).join(" ")} The change
            is kept, and the next change to the agent applies it again.
          </span>
        </Callout>
      )}
    </>
  );
}
