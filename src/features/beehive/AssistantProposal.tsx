import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { Client } from "./engine/client";
import { EngineError, errorMessage } from "./engine/transport";
import type { Finding, OpenProposal } from "./gen/kiln/engine/v1/engine_pb";
import { Findings } from "./Findings";
import type { Files } from "./workflowDraft";

type Read =
  | { status: "loading" }
  | { status: "ready"; current: Files; findings: Finding[] }
  | { status: "error"; message: string };

const decoder = new TextDecoder();

/** The proposal's files as text, by path. */
function filesOf(proposal: OpenProposal): Files {
  return Object.fromEntries(
    Object.entries(proposal.draft?.files ?? {}).map(([path, bytes]) => [
      path,
      decoder.decode(bytes),
    ]),
  );
}

/**
 * A workflow the assistant offered, with what it changes against the saved version and what the
 * checks say. Apply saves it with the person's own level, against the hash the agent named, so a
 * workflow that changed since is refused with the engine's words. Discard keeps nothing.
 */
export function AssistantProposal({
  client,
  proposal,
  canRun,
  onDecided,
}: {
  client: Client;
  proposal: OpenProposal;
  canRun: boolean;
  onDecided(id: bigint, applied: boolean): void;
}) {
  const name = proposal.draft?.name ?? "";
  const files = filesOf(proposal);
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [showing, setShowing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const notify = useToastNotification();

  useEffect(() => {
    const abort = new AbortController();
    const proposed = filesOf(proposal);
    Promise.all([
      client.getWorkflowDraft(name, abort.signal).then(
        (opened) => ({ ...opened.textFiles }),
        // A new package has nothing saved to compare with.
        (failure: unknown) =>
          failure instanceof EngineError && failure.code === "not_found"
            ? {}
            : Promise.reject(failure),
      ),
      client.checkDraft({ name, files: proposed }, abort.signal),
    ])
      .then(([current, checked]) => {
        if (abort.signal.aborted) return;
        setRead({
          status: "ready",
          current,
          findings: checked.packages.flatMap((entry) => entry.findings),
        });
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setRead({ status: "error", message: errorMessage(failure) });
      });
    return () => abort.abort();
  }, [client, name, proposal]);

  const current = read.status === "ready" ? read.current : {};
  const changed = Object.keys({ ...current, ...files })
    .filter((path) => current[path] !== files[path])
    .sort();
  const problems =
    read.status === "ready"
      ? read.findings.filter((finding) => finding.severity === "error")
      : [];

  const decide = async (applied: boolean) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      if (applied) {
        const saved = await client.saveWorkflow(
          { name, files },
          proposal.baseHash,
        );
        // The version is saved: a failure to record the decision leaves nothing to redo.
        await client.resolveProposal(proposal.id, true).catch(() => undefined);
        const version = saved.workflow?.version;
        notify(version ? `Saved version ${version}` : "Saved", "success");
      } else {
        await client.resolveProposal(proposal.id, false);
      }
      onDecided(proposal.id, applied);
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  return (
    <section
      className="beehive-proposal"
      aria-label={`Proposed edit to ${name}`}
    >
      <div>
        <p className="text-label">
          {read.status === "ready"
            ? `Proposed edit: ${changed.length} ${changed.length === 1 ? "file" : "files"} changed`
            : "Proposed edit"}
        </p>
        <p className="text-body-sm text-subtle">{name}</p>
      </div>
      {read.status === "error" && (
        <p role="alert" className="text-danger">
          {`Could not compare it with the saved version. ${read.message}`}
        </p>
      )}
      {read.status === "ready" && (
        <>
          <ul className="beehive-proposal-files text-mono-sm">
            {changed.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {problems.length === 0 ? (
            <p className="text-body-sm text-subtle">Checks pass</p>
          ) : (
            <Findings label={name} findings={read.findings} />
          )}
          {changed.length > 0 && (
            <Button
              size="sm"
              aria-expanded={showing}
              onClick={() => setShowing((on) => !on)}
            >
              {showing ? "Hide changes" : "Show changes"}
            </Button>
          )}
          {showing &&
            changed.map((path) => (
              <div key={path} className="beehive-proposal-diff">
                {(["Current", "Proposed"] as const).map((side) => {
                  const text = (side === "Current" ? current : files)[path];
                  return (
                    <section key={side} aria-label={`${side} ${path}`}>
                      <pre className="text-mono-sm">
                        {text ?? `Not in the ${side.toLowerCase()} version`}
                      </pre>
                    </section>
                  );
                })}
              </div>
            ))}
        </>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="beehive-callout-actions">
        <Button disabled={pending} onClick={() => void decide(false)}>
          Discard
        </Button>
        <Button
          variant="prominent"
          loading={pending}
          disabled={pending || !canRun}
          onClick={() => void decide(true)}
        >
          Apply
        </Button>
      </div>
    </section>
  );
}
