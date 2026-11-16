import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { AgentLoginDialog } from "./AgentLoginDialog";
import { Callout } from "./Callout";
import type { Client } from "./engine/client";
import { EngineError, errorMessage } from "./engine/transport";
import type {
  AgentSettingIssue,
  AgentToolServer,
  AgentToolServers,
  AgentToolsChange,
} from "./gen/kiln/engine/v1/engine_pb";
import { ToolServerDialog } from "./ToolServerDialog";
import { describe } from "./toolServer";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; agents: readonly AgentToolServers[] }
  | { status: "error"; message: string };

type Health =
  | { status: "loading" }
  | { status: "ready"; issues: readonly AgentSettingIssue[] }
  | { status: "error"; message: string };

/** The key of a server in the sign-in states. */
const loginKey = (agent: string, server: string) => `${agent}\n${server}`;

/** What the last save or removal did, as the engine reported it. */
type Outcome = { verb: "Saved" | "Removed"; name: string } & Pick<
  AgentToolsChange,
  "applied" | "restarted" | "applyError"
> & { agent: string };

/**
 * The tool servers each agent starts during a stage. Only an admin sees it. A change is saved
 * first and applied second: the host writes the agent's files and restarts it when they
 * changed, and a restart ends the work the agent is doing. The engine says which of the two
 * happened, and this shows it as it was said, including a change that was saved and not applied.
 * Beside the list it shows the agents the host reports as not set up for stage threads.
 */
export function AgentToolsSettings({ client }: { client: Client }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [health, setHealth] = useState<Health>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [healthAttempt, setHealthAttempt] = useState(0);
  const [editing, setEditing] = useState<
    { agent: string; server: AgentToolServer } | "new"
  >();
  const [removing, setRemoving] = useState<{
    agent: string;
    server: AgentToolServer;
  }>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [logins, setLogins] = useState<Record<string, string>>({});
  const [loginNote, setLoginNote] = useState<string>();
  const [loginCheck, setLoginCheck] = useState(0);
  const [connecting, setConnecting] = useState<{
    agent: string;
    server: string;
  }>();
  const cancelRemove = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const recheck = useCallback(() => setHealthAttempt((n) => n + 1), []);

  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    setLoaded({ status: "loading" });
    client
      .listAgentToolServers(abort.signal)
      .then((reply) => {
        if (!abort.signal.aborted)
          setLoaded({ status: "ready", agents: reply.agents });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setLoaded({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, attempt]);

  useEffect(() => {
    // `healthAttempt` reads again after a change, which applies the agent's settings too.
    void healthAttempt;
    const abort = new AbortController();
    client
      .getHiveHealth(abort.signal)
      .then((reply) => {
        if (!abort.signal.aborted)
          setHealth({ status: "ready", issues: reply.agentIssues });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setHealth({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, healthAttempt]);

  const hostedKey = useMemo(
    () =>
      JSON.stringify(
        (loaded.status === "ready" ? loaded.agents : []).flatMap((entry) =>
          entry.servers
            .filter((server) => server.transport === "http")
            .map((server) => [entry.agent, server.name]),
        ),
      ),
    [loaded],
  );

  useEffect(() => {
    // Whether each hosted server holds a sign-in is read once the list is known, one at a time
    // (the host lists the agent's servers for each), and again on request.
    void loginCheck;
    const abort = new AbortController();
    const hosted = JSON.parse(hostedKey) as [string, string][];
    setLoginNote(undefined);
    void (async () => {
      for (const [agent, server] of hosted) {
        try {
          const reply = await client.getAgentLoginStatus(
            agent,
            server,
            abort.signal,
          );
          if (abort.signal.aborted) return;
          setLogins((was) => ({
            ...was,
            [loginKey(agent, server)]: reply.state,
          }));
        } catch (error) {
          if (abort.signal.aborted) return;
          setLoginNote((was) => was ?? errorMessage(error));
          // No host to ask, or one that cannot be reached: every other server would fail the same way.
          if (
            error instanceof EngineError &&
            error.code === "failed_precondition"
          )
            return;
        }
      }
    })();
    return () => abort.abort();
  }, [client, hostedKey, loginCheck]);

  /** The agent's list as the engine now holds it replaces the one on screen. */
  const changed = (
    verb: Outcome["verb"],
    name: string,
    agent: string,
    change: AgentToolsChange,
  ) => {
    const list = change.agent;
    if (list)
      setLoaded((was) =>
        was.status === "ready"
          ? {
              status: "ready",
              agents: was.agents.map((entry) =>
                entry.agent === agent ? list : entry,
              ),
            }
          : was,
      );
    else retry();
    setOutcome({
      verb,
      name,
      agent,
      applied: change.applied,
      restarted: change.restarted,
      applyError: change.applyError,
    });
    recheck();
  };

  const remove = async ({
    agent,
    server,
  }: {
    agent: string;
    server: AgentToolServer;
  }) => {
    if (pending) return;
    setPending(true);
    setFailure(undefined);
    try {
      changed(
        "Removed",
        server.name,
        agent,
        await client.removeAgentToolServer(agent, server.name),
      );
      setRemoving(undefined);
      requestAnimationFrame(() => addButton.current?.focus());
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  const agents = loaded.status === "ready" ? loaded.agents : [];
  return (
    <>
      <InlineHeader
        title="Agent tools"
        subtitle="Tool servers each agent can use during a stage."
        actions={
          <Button
            ref={addButton}
            disabled={agents.length === 0 || pending}
            onClick={() => setEditing("new")}
          >
            Add tool server
          </Button>
        }
      />
      {outcome && <Applied outcome={outcome} />}
      <Issues health={health} onRetry={recheck} />
      {loginNote && (
        <p role="status" className="text-body-sm text-subtle">
          {`Could not check the tool server sign-ins. ${loginNote} `}
          <Button
            size="inline"
            variant="link"
            onClick={() => setLoginCheck((n) => n + 1)}
          >
            Check sign-ins again
          </Button>
        </p>
      )}
      <LoadingRegion
        pending={loaded.status === "loading"}
        label="Loading tool servers…"
        feedback={
          loaded.status === "error" ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {loaded.message}
              </p>
              <Button onClick={retry}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {loaded.status === "ready" && agents.length === 0 && (
          <p className="text-body-sm text-subtle">
            No agents are set up for Beehive yet. An agent appears here once
            Beehive's host has it.
          </p>
        )}
        {agents.map((entry) => (
          <section
            key={entry.agent}
            aria-label={`Tool servers of ${entry.agent}`}
          >
            <InlineHeader level={4} title={entry.agent} />
            {entry.servers.length === 0 ? (
              <p className="text-body-sm text-subtle">No tool servers.</p>
            ) : (
              <SettingsGroup>
                {entry.servers.map((server) => (
                  <PreferenceRow
                    key={server.name}
                    title={server.name}
                    subtitle={
                      <span className="break-words">{describe(server)}</span>
                    }
                    trailing={
                      <>
                        {server.transport === "http" && (
                          <>
                            <LoginState
                              state={logins[loginKey(entry.agent, server.name)]}
                            />
                            <Button
                              size="sm"
                              aria-label={`Connect ${server.name} on ${entry.agent}`}
                              disabled={pending}
                              onClick={() =>
                                setConnecting({
                                  agent: entry.agent,
                                  server: server.name,
                                })
                              }
                            >
                              Connect
                            </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          aria-label={`Edit ${server.name} on ${entry.agent}`}
                          disabled={pending}
                          onClick={() =>
                            setEditing({ agent: entry.agent, server })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          aria-label={`Remove ${server.name} from ${entry.agent}`}
                          disabled={pending}
                          onClick={() => {
                            setFailure(undefined);
                            setRemoving({ agent: entry.agent, server });
                          }}
                        >
                          Remove
                        </Button>
                      </>
                    }
                  />
                ))}
              </SettingsGroup>
            )}
          </section>
        ))}
      </LoadingRegion>
      {connecting && (
        <AgentLoginDialog
          client={client}
          agent={connecting.agent}
          server={connecting.server}
          onClose={() => setConnecting(undefined)}
          onSignedIn={(state) => {
            setLogins((was) => ({
              ...was,
              [loginKey(connecting.agent, connecting.server)]: state,
            }));
            setConnecting(undefined);
          }}
        />
      )}
      {editing && loaded.status === "ready" && (
        <ToolServerDialog
          client={client}
          agents={agents}
          editing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(agent, name, change) => {
            setEditing(undefined);
            changed("Saved", name, agent, change);
          }}
        />
      )}
      {removing && (
        <AlertDialog
          title={`Remove ${removing.server.name} from ${removing.agent}?`}
          description="The agent loses this tool server. If its files change, the agent restarts, and a restarted agent restarts the work it is doing now."
          pending={pending}
          initialFocus={cancelRemove}
          onClose={() => setRemoving(undefined)}
          actions={
            <>
              <Button
                ref={cancelRemove}
                disabled={pending}
                onClick={() => setRemoving(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={pending}
                onClick={() => void remove(removing)}
              >
                Remove tool server
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

/** Whether the agent holds a sign-in for a hosted server, once the host has said. */
function LoginState({ state }: { state: string | undefined }) {
  if (!state) return null;
  const connected = state === "connected";
  return (
    <span
      className="beehive-chip text-body-sm"
      data-status={connected ? "done" : undefined}
    >
      {connected ? "Connected" : "Needs sign-in"}
    </span>
  );
}

/** Capitalizes the engine's reason and ends it with one full stop. */
function sentence(text: string): string {
  const reason = text.trim().replace(/[.!?\s]+$/, "");
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

/** What the engine said happened to the agent after a change. */
function Applied({ outcome }: { outcome: Outcome }) {
  const { agent } = outcome;
  const done = `${outcome.verb} ${outcome.name} ${outcome.verb === "Saved" ? "on" : "from"} ${agent}.`;
  if (!outcome.applied)
    return (
      <Callout
        tone="warning"
        title={`${outcome.verb}, but ${agent} does not have the change yet`}
      >
        <span role="alert">
          {sentence(outcome.applyError || "Beehive's host did not apply it")}{" "}
          The change is kept, and the next change to this agent applies its
          whole list again.
        </span>
      </Callout>
    );
  return (
    <p role="status" className="text-body">
      {`${done} ${
        outcome.restarted
          ? `${agent} restarted, and a restarted agent restarts the work it is doing now.`
          : `${agent} did not need to restart.`
      }`}
    </p>
  );
}

/** The agents the host reports as not on a thread session or not answering Beehive. */
function Issues({ health, onRetry }: { health: Health; onRetry(): void }) {
  if (health.status === "error")
    return (
      <p role="status" className="text-body-sm text-subtle">
        {`Could not check whether the agents are set up for stage threads. ${health.message} `}
        <Button size="inline" variant="link" onClick={onRetry}>
          Check again
        </Button>
      </p>
    );
  if (health.status !== "ready") return null;
  return health.issues.map((issue) => (
    <Callout
      key={issue.agent}
      tone="warning"
      title={`${issue.agent} is not set up for stage threads`}
    >
      {issue.problem}
    </Callout>
  ));
}
