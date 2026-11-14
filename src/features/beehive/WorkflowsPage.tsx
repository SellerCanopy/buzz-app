import { useCallback, useEffect, useState } from "react";
import { HexagonIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { Client } from "./engine/client";
import type {
  Finding,
  PackageCheck,
  Workflow,
  WorkflowStage,
} from "./gen/kiln/engine/v1/engine_pb";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; workflows: Workflow[]; checks: PackageCheck[] }
  | { status: "error"; message: string };

/** The packages the engine loaded, and what its checks found in each. Read once; `retry` reads again. */
function useWorkflows(client: Client) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    setLoaded({ status: "loading" });
    Promise.all([
      client.listWorkflows(abort.signal),
      client.checkWorkflow("", abort.signal),
    ])
      .then(([list, check]) => {
        if (abort.signal.aborted) return;
        setLoaded({
          status: "ready",
          workflows: list.workflows,
          checks: check.packages,
        });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setLoaded({
          status: "error",
          message:
            error instanceof Error ? error.message : "Beehive did not answer",
        });
      });
    return () => abort.abort();
  }, [client, attempt]);
  return { loaded, retry };
}

const KINDS: Record<string, string> = {
  prompt: "Prompt",
  approval: "Approval",
  wait: "Wait",
  action: "Action",
};

const SEVERITIES: Record<string, { label: string; tone: string }> = {
  error: { label: "Error", tone: "text-danger" },
  warning: { label: "Warning", tone: "text-warning" },
  note: { label: "Note", tone: "text-subtle" },
};

/** What a stage does, in a line: its kind, the agent a prompt runs on, and a pause. */
export function stageSummary(stage: WorkflowStage): string {
  const parts = [KINDS[stage.kind] ?? stage.kind];
  if (stage.agent) parts.push(`agent ${stage.agent}`);
  if (stage.pause) parts.push("waits for a person to start it");
  return parts.join(", ");
}

/** Every package the engine loaded with its stages and findings, and the folders that did not load. Read only. */
export function WorkflowsPage({ client }: { client: Client }) {
  const { loaded, retry } = useWorkflows(client);
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
          {workflows.map((workflow) => (
            <WorkflowSection
              key={workflow.name}
              workflow={workflow}
              findings={findingsOf(workflow.name)}
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
                  <p className="text-body-sm text-subtle">{check.path}</p>
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
}: {
  workflow: Workflow;
  findings: Finding[];
}) {
  const details = [
    workflow.builtin ? "Built in" : undefined,
    workflow.version ? `Version ${workflow.version}` : undefined,
  ].filter(Boolean);
  return (
    <section aria-label={workflow.name} className="beehive-workflow">
      <InlineHeader
        title={workflow.name}
        subtitle={workflow.description || undefined}
        actions={
          <span
            className={`text-body-sm ${workflow.ok ? "text-subtle" : "text-danger"}`}
          >
            {workflow.ok ? "Ready" : "Has errors"}
          </span>
        }
      />
      {details.length > 0 && (
        <p className="text-body-sm text-subtle">{details.join(", ")}</p>
      )}
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

function Findings({ label, findings }: { label: string; findings: Finding[] }) {
  if (!findings.length) return null;
  return (
    <ul className="beehive-findings" aria-label={`Findings for ${label}`}>
      {findings.map((finding) => {
        const severity = SEVERITIES[finding.severity] ?? {
          label: finding.severity,
          tone: "text-subtle",
        };
        return (
          <li key={`${finding.path}|${finding.code}|${finding.message}`}>
            <span className={`text-body-sm ${severity.tone}`}>
              {severity.label}
            </span>{" "}
            <code className="text-mono-sm">{finding.code}</code>{" "}
            {finding.message}
            {finding.path && (
              <span className="text-body-sm text-subtle">
                {" "}
                ({finding.path})
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
