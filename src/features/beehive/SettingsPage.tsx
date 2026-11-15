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
import { errorMessage } from "./engine/transport";

const UPDATE_CHANNEL = "update_channel";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; channel: string }
  | { status: "error"; message: string };

/** The channel id inside a stored setting value, or "" when none is set. */
export function channelOf(valueJson: string | undefined): string {
  if (!valueJson) return "";
  try {
    const value: unknown = JSON.parse(valueJson);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/**
 * Where Beehive posts a run's status and its stage tasks. Everyone reads it;
 * only an admin changes it. An admin also sets what each person and agent may do. The engine checks the channel on save, and its
 * answer is shown beside the setting as it gives it.
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
    client
      .getCommunitySettings(abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        const setting = reply.settings.find((s) => s.key === UPDATE_CHANNEL);
        setLoaded({ status: "ready", channel: channelOf(setting?.valueJson) });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setLoaded({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, attempt]);

  const save = async (channel: string) => {
    if (pending) return;
    setPending(true);
    setSaveError(undefined);
    try {
      await client.setCommunitySetting(
        UPDATE_CHANNEL,
        channel ? JSON.stringify(channel) : "",
      );
      setLoaded({ status: "ready", channel });
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
                onChange={(next) => void save(next)}
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
