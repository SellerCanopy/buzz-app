import { useCallback, useEffect, useState } from "react";
import { HexagonIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import { kindLabel } from "./workflowDraft";
import { Findings } from "./Findings";
import type {
  Finding,
  PackageCheck,
  Workflow,
  WorkflowStage,
} from "./gen/kiln/engine/v1/engine_pb";

type Loaded =
  | { status: "loading" }
  | {
      status: "ready";
      workflows: Workflow[];
      checks: PackageCheck[];
      /** Why the checks could not run; the list shows without their findings. */
      checkError?: string;
    }
  | { status: "error"; message: string };

/**
 * The packages the engine loaded, and what its checks found in each. Read once; `retry` reads
 * again, and so does a new `revision`, which the page bumps when a workflow was saved.
 */
function useWorkflows(client: Client, revision: number) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    // `attempt` and `revision` restart the read; neither is otherwise used.
    void attempt;
    void revision;
    const abort = new AbortController();
    setLoaded({ status: "loading" });
    Promise.all([
      client.listWorkflows(abort.signal),
      // The checks are the heavier read and only decorate the list, so their failure keeps it.
      client.checkWorkflow(abort.signal).then(
        (check) => ({ checks: check.packages }),
        (error: unknown) => ({
          checks: [] as PackageCheck[],
          checkError: errorMessage(error),
        }),
      ),
    ])
      .then(([list, check]) => {
        if (abort.signal.aborted) return;
        setLoaded({ status: "ready", workflows: list.workflows, ...check });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setLoaded({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, attempt, revision]);
  return { loaded, retry };
}

/**
 * What a stage does, in a line: its kind, the agent a prompt runs on, and who it waits for. An
 * approval waits for a person by its nature; any stage may also hold a card until a person
 * starts it.
 */
export function stageSummary(stage: WorkflowStage): string {
  const parts = [kindLabel(stage.kind, "list")];
  if (stage.agent) parts.push(`agent ${stage.agent}`);
  if (stage.pause) parts.push("waits for a person to start it");
  else if (stage.kind === "approval") parts.push("waits for a person");
  return parts.join(", ");
}

/**
 * Every package the engine loaded with its stages and findings, and the folders that did not
 * load. A person who can run opens one in the editor; anyone else opens it to read.
 */
export function WorkflowsPage({
  client,
  canRun = false,
  revision = 0,
  onEdit,
}: {
  client: Client;
  canRun?: boolean;
  /** Changes when a workflow was saved, deleted or imported, so the list reads again. */
  revision?: number;
  onEdit?(name: string): void;
}) {
  const { loaded, retry } = useWorkflows(client, revision);
  const failed = loaded.status === "error";
  const workflows = loaded.status === "ready" ? loaded.workflows : [];
  const checks = loaded.status === "ready" ? loaded.checks : [];
  // A folder that failed to load has no package name, so its findings stand alone.
  const unloaded = checks.filter((check) => !check.name);
  const findingsOf = (name: string) =>
    checks
      .filter((check) => check.name === name)
      .flatMap((check) => check.findings);
  const empty =
    loaded.status === "ready" && workflows.length === 0 && !unloaded.length;
  return (
    <LoadingRegion
      pending={loaded.status === "loading"}
      label="Loading workflows…"
      feedback={
        failed ? (
          <div className="beehive-error">
            <p role="alert" className="text-danger">
              {loaded.message}
            </p>
            <Button onClick={retry}>Retry</Button>
          </div>
        ) : undefined
      }
    >
      {empty && (
        <EmptyState
          icon={<HexagonIcon size="1.5rem" />}
          title="No workflows"
          description="Workflow packages this Beehive loads will be listed here."
        />
      )}
      {loaded.status === "ready" && !empty && (
        <div className="beehive-workflows">
          {loaded.checkError && (
            <p role="alert" className="text-body-sm text-danger">
              {`Checks could not run. ${loaded.checkError}`}
            </p>
          )}
          {workflows.map((workflow) => (
            <WorkflowSection
              key={workflow.name}
              workflow={workflow}
              findings={findingsOf(workflow.name)}
              canRun={canRun}
              onEdit={onEdit}
            />
          ))}
          {unloaded.length > 0 && (
            <section
              aria-label="Packages that did not load"
              className="beehive-workflow"
            >
              <InlineHeader title="Packages that did not load" />
              {unloaded.map((check) => (
                <div key={check.path}>
                  <p className="text-body-sm text-subtle">
                    <span>{check.path}</span>{" "}
                    <span className="text-danger">Not loaded</span>
                  </p>
                  <Findings label={check.path} findings={check.findings} />
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </LoadingRegion>
  );
}

function WorkflowSection({
  workflow,
  findings,
  canRun,
  onEdit,
}: {
  workflow: Workflow;
  findings: Finding[];
  canRun: boolean;
  onEdit: ((name: string) => void) | undefined;
}) {
  // `Built in, version 0.1.0.` for a package every build ships, `Version 1` for the rest.
  const details = workflow.builtin
    ? ["Built in", workflow.version && `version ${workflow.version}`]
        .filter(Boolean)
        .join(", ")
    : workflow.version
      ? `Version ${workflow.version}`
      : "";
  return (
    <section aria-label={workflow.name} className="beehive-workflow">
      <InlineHeader
        title={workflow.name}
        subtitle={workflow.description || undefined}
        actions={
          <>
            {workflow.builtin && <span className="beehive-tag">Built in</span>}
            <span
              className={`text-body-sm ${workflow.ok ? "text-subtle" : "text-danger"}`}
            >
              {workflow.ok ? "Ready" : "Has problems"}
            </span>
            {onEdit && (
              <Button
                size="sm"
                aria-label={`${canRun ? "Edit" : "View"} ${workflow.name}`}
                onClick={() => onEdit(workflow.name)}
              >
                {canRun ? "Edit" : "View"}
              </Button>
            )}
          </>
        }
      />
      {details && <p className="text-body-sm text-subtle">{details}</p>}
      {workflow.stages.length > 0 && (
        <ol
          className="beehive-stages"
          aria-label={`Stages of ${workflow.name}`}
        >
          {workflow.stages.map((stage) => (
            <li key={stage.id}>
              <span>{stage.name || stage.id}</span>
              <span className="text-body-sm text-subtle">
                {stageSummary(stage)}
              </span>
            </li>
          ))}
        </ol>
      )}
      <Findings label={workflow.name} findings={findings} />
    </section>
  );
}
