import { useCallback, useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { AccessEntry } from "./gen/kiln/engine/v1/engine_pb";
import { LEVELS, atLeast, parseLevel, type Level } from "./level";

const LABELS: Record<Level, string> = {
  none: "None",
  read: "Read",
  run: "Run",
  admin: "Admin",
};
const MEANING: Record<Level, string> = {
  none: "Cannot open Beehive",
  read: "Can look, cannot change",
  run: "Can add cards and run stages",
  admin: "Can also set levels and settings",
};

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
  const [failure, setFailure] = useState<{ pubkey: string; message: string }>();
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

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
    setSaving(entry.pubkey);
    setFailure(undefined);
    try {
      await client.setAccessLevel(entry.pubkey, level);
      // Read the list again: an owner's level also moves its agents.
      const reply = await client.listAccess();
      setLoaded({ status: "ready", entries: reply.entries });
    } catch (error) {
      // The saved level stands: the select shows it again.
      setFailure({ pubkey: entry.pubkey, message: errorMessage(error) });
    } finally {
      setSaving(undefined);
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
    const mine = entry.pubkey === me;
    const options = LEVELS.map((choice) => {
      const aboveOwner = entry.kind === "agent" && !atLeast(ownerLevel, choice);
      const lowersMe = mine && choice !== "admin";
      return {
        value: choice,
        label: LABELS[choice],
        description: aboveOwner
          ? `Above its owner's level (${LABELS[ownerLevel]})`
          : lowersMe
            ? "You cannot lower your own level"
            : MEANING[choice],
        disabled: (aboveOwner || lowersMe) && choice !== level,
      };
    });
    const problem = failure?.pubkey === entry.pubkey ? failure.message : "";
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
          </>
        }
        trailing={
          <Select
            label={`Level for ${nameOf(entry)}`}
            variant="preference"
            value={level}
            disabled={saving !== undefined}
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
