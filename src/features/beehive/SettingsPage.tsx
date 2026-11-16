import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { RelayData } from "../relay/service";
import { useChannelList, useRelayConnection } from "../relay/react";
import { AccessSettings } from "./AccessSettings";
import type { Client } from "./engine/client";
import {
  ASSISTANT_AGENT,
  UPDATE_CHANNEL,
  beehiveSettings,
} from "./engine/settings";
import { errorMessage } from "./engine/transport";

type Loaded =
  | { status: "loading" }
  | {
      status: "ready";
      channel: string;
      agent: string;
      /** The agents the assistant may be, by display name. */
      agents: string[];
    }
  | { status: "error"; message: string };

/**
 * Where Beehive posts a run's status and its stage tasks, and which agent answers in the
 * Assistant. Everyone reads them; only an admin changes them. An admin also sets what each
 * person and agent may do. The engine checks each setting on save, and its answer is shown
 * beside the setting as it gives it.
 */
export function SettingsPage({
  client,
  relay,
  isAdmin,
  me,
}: {
  client: Client;
  relay: RelayData;
  isAdmin: boolean;
  /** The signed-in person's pubkey. */
  me: string;
}) {
  const connection = useRelayConnection(relay);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    setLoaded({ status: "loading" });
    Promise.all([
      client.getCommunitySettings(abort.signal),
      client.listAgents(abort.signal),
    ])
      .then(([reply, agents]) => {
        if (abort.signal.aborted) return;
        setLoaded({
          status: "ready",
          ...beehiveSettings(reply),
          agents: agents.agents.map((agent) => agent.name),
        });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setLoaded({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, attempt]);

  const save = async (key: string, value: string) => {
    if (pending) return;
    setPending(true);
    setSaveError(undefined);
    try {
      await client.setCommunitySetting(key, value ? JSON.stringify(value) : "");
      setLoaded((was) =>
        was.status === "ready"
          ? {
              ...was,
              ...(key === UPDATE_CHANNEL
                ? { channel: value }
                : { agent: value }),
            }
          : was,
      );
    } catch (error) {
      // The saved value stands: the select shows it again.
      setSaveError(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="beehive-settings">
      <InlineHeader title="Updates" />
      <LoadingRegion
        pending={loaded.status === "loading"}
        label="Loading settings…"
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
        {loaded.status === "ready" && (
          <>
            <SettingsGroup>
              <ChannelChoice
                relay={connection.session}
                ready={connection.status === "ready"}
                value={loaded.channel}
                disabled={!isAdmin || pending}
                isAdmin={isAdmin}
                onChange={(next) => void save(UPDATE_CHANNEL, next)}
              />
              <AgentChoice
                value={loaded.agent}
                agents={loaded.agents}
                disabled={!isAdmin || pending}
                onChange={(next) => void save(ASSISTANT_AGENT, next)}
              />
            </SettingsGroup>
            {saveError && (
              <p role="alert" className="text-danger">
                {saveError}
              </p>
            )}
          </>
        )}
      </LoadingRegion>
      {isAdmin && <AccessSettings client={client} me={me} />}
    </div>
  );
}

function ChannelChoice({
  relay,
  ready,
  value,
  disabled,
  isAdmin,
  onChange,
}: {
  relay: ReturnType<RelayData["snapshot"]>["session"];
  ready: boolean;
  value: string;
  disabled: boolean;
  isAdmin: boolean;
  onChange(channel: string): void;
}) {
  const list = useChannelList(relay.channels);
  const options = useMemo(() => {
    const channels = list.channels
      .filter((c) => c.channelType === "stream" && !c.archived)
      .map((c) => ({ value: c.id, label: `# ${c.name}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // A saved channel this person cannot see still shows, so the select does
    // not read as unset.
    const known = value === "" || channels.some((c) => c.value === value);
    return [
      { value: "", label: "No channel" },
      ...(known ? [] : [{ value, label: "A channel you are not in" }]),
      ...channels,
    ];
  }, [list.channels, value]);
  return (
    <PreferenceRow
      title="Update channel"
      subtitle={
        isAdmin
          ? "Beehive posts a run's status and its stage tasks here. Add the Beehive account to the channel before you choose it."
          : "Beehive posts a run's status and its stage tasks here. An admin chooses the channel."
      }
      trailing={
        <Select
          label="Update channel"
          variant="preference"
          value={value}
          disabled={disabled || !ready}
          onValueChange={onChange}
          groups={[{ label: "Channels", options }]}
        />
      }
    />
  );
}

function AgentChoice({
  value,
  agents,
  disabled,
  onChange,
}: {
  value: string;
  agents: string[];
  disabled: boolean;
  onChange(agent: string): void;
}) {
  const options = useMemo(() => {
    const names = [...agents].sort((a, b) => a.localeCompare(b));
    // A saved agent that is no longer listed still shows, so the select does not read as unset.
    const known = value === "" || names.includes(value);
    return [
      { value: "", label: "No agent" },
      ...(known ? [] : [{ value, label: value }]),
      ...names.map((name) => ({ value: name, label: name })),
    ];
  }, [agents, value]);
  return (
    <PreferenceRow
      title="Assistant agent"
      subtitle="The agent that answers in the Assistant."
      trailing={
        <Select
          label="Assistant agent"
          variant="preference"
          value={value}
          disabled={disabled}
          onValueChange={onChange}
          groups={[{ label: "Agents", options }]}
        />
      }
    />
  );
}
