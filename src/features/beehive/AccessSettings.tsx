import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { AccessEntry } from "./gen/kiln/engine/v1/engine_pb";
import {
  LABELS,
  LEVELS,
  MEANING,
  assignable,
  parseLevel,
  type Level,
} from "./level";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; entries: readonly AccessEntry[] }
  | { status: "error"; message: string };

const shortKey = (pubkey: string) => `${pubkey.slice(0, 8)}…`;
const nameOf = (entry: AccessEntry) => entry.name || shortKey(entry.pubkey);

/**
 * What each person and agent may do in Beehive. Only an admin sees it. A change saves at
 * once and the list is read again, because lowering a person also lowers their agents. The
 * engine refuses an agent above its owner and an admin lowering themselves; the options
 * that would be refused are unavailable, and the engine's answer is shown beside the row if
 * one still comes back.
 */
export function AccessSettings({
  client,
  me,
}: {
  client: Client;
  /** The signed-in person's pubkey. */
  me: string;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState<string>();
  const [failure, setFailure] = useState<{
    pubkey: string;
    message: string;
    /** The level saved and only the list could not be read again. */
    saved?: true;
  }>();
  const retry = useCallback(() => {
    setFailure(undefined);
    setAttempt((n) => n + 1);
  }, []);
  /** Ends with the component, so a save or read that is still out does not touch it after. */
  const lifetime = useRef<AbortController>(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);

  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    setLoaded({ status: "loading" });
    client
      .listAccess(abort.signal)
      .then((reply) => {
        if (!abort.signal.aborted)
          setLoaded({ status: "ready", entries: reply.entries });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setLoaded({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, attempt]);

  const change = async (entry: AccessEntry, level: string) => {
    if (saving) return;
    const { signal } = lifetime.current;
    setSaving(entry.pubkey);
    setFailure(undefined);
    try {
      try {
        await client.setAccessLevel(entry.pubkey, level, signal);
      } catch (error) {
        // Nothing was saved: the select shows the level it had.
        if (!signal.aborted)
          setFailure({ pubkey: entry.pubkey, message: errorMessage(error) });
        return;
      }
      try {
        // Read the list again: an owner's level also moves its agents.
        const reply = await client.listAccess(signal);
        if (!signal.aborted)
          setLoaded({ status: "ready", entries: reply.entries });
      } catch (error) {
        // The level saved, so say so rather than call it a failed save.
        if (!signal.aborted)
          setFailure({
            pubkey: entry.pubkey,
            message: `Saved, but the list could not be refreshed. ${errorMessage(error)}`,
            saved: true,
          });
      }
    } finally {
      if (!signal.aborted) setSaving(undefined);
    }
  };

  const entries = loaded.status === "ready" ? loaded.entries : [];
  const people = entries.filter((entry) => entry.kind === "person");
  const agents = entries.filter((entry) => entry.kind === "agent");
  const levelOf = (pubkey: string): Level =>
    parseLevel(entries.find((e) => e.pubkey === pubkey)?.level ?? "");

  const row = (entry: AccessEntry) => {
    const level = parseLevel(entry.level);
    const ownerLevel = entry.ownerPubkey ? levelOf(entry.ownerPubkey) : "admin";
    const owner = entries.find((e) => e.pubkey === entry.ownerPubkey);
    const options = LEVELS.map((choice) => {
      const { allowed, reason } = assignable(
        { pubkey: entry.pubkey, kind: entry.kind, level, ownerLevel },
        me,
        choice,
      );
      return {
        value: choice,
        label: LABELS[choice],
        description: reason ?? MEANING[choice],
        disabled: !allowed,
      };
    });
    const mine = failure?.pubkey === entry.pubkey ? failure : undefined;
    const problem = mine?.message ?? "";
    return (
      <PreferenceRow
        key={entry.pubkey}
        title={nameOf(entry)}
        subtitle={
          <>
            {entry.kind === "agent"
              ? `Agent owned by ${owner ? nameOf(owner) : shortKey(entry.ownerPubkey)}, never above its owner's level.`
              : shortKey(entry.pubkey)}
            {problem && (
              <span role="alert" className="text-danger">
                {" "}
                {problem}
              </span>
            )}
            {mine?.saved && (
              <Button size="inline" variant="link" onClick={retry}>
                Retry
              </Button>
            )}
          </>
        }
        trailing={
          <Select
            label={`Level for ${nameOf(entry)}`}
            variant="preference"
            value={level}
            disabled={saving !== undefined && saving !== entry.pubkey}
            onValueChange={(next) => void change(entry, next)}
            groups={[{ label: "Levels", options }]}
          />
        }
      />
    );
  };

  return (
    <>
      <InlineHeader title="Access" />
      <LoadingRegion
        pending={loaded.status === "loading"}
        label="Loading access…"
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
            <SettingsGroup>{people.map(row)}</SettingsGroup>
            {agents.length > 0 && (
              <>
                <InlineHeader title="Agents" />
                <SettingsGroup>{agents.map(row)}</SettingsGroup>
              </>
            )}
          </>
        )}
      </LoadingRegion>
    </>
  );
}
