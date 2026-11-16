import { XIcon } from "../../shared/design-system/icons";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { AgentInfo } from "./gen/kiln/engine/v1/engine_pb";
import { RESULTS } from "./StageCanvas";
import {
  kindLabel,
  packageInfo,
  PACKAGE_FILE,
  renameStage,
  setDescription,
  setStageField,
  setStageRoute,
  WORKFLOW_FILE,
  type DraftStage,
  type Files,
} from "./workflowDraft";

/** The words for a result the engine routes on, as a question the route answers. */
const ROUTE_LABELS: Record<string, { label: string; unset: string }> = {
  passed: { label: "When it passes", unset: "Next step" },
  needs_work: { label: "When it needs more work", unset: "Default" },
  failed: { label: "When it fails", unset: "Stop the workflow" },
  needs_input: { label: "When it needs your input", unset: "Default" },
};

/** The agents to offer, and the one the stage already names even when it is not one of them. */
function agentOptions(agents: AgentInfo[], current: unknown) {
  const options = agents.map((agent) => ({
    value: agent.name,
    label: agent.name,
  }));
  if (
    typeof current === "string" &&
    current &&
    !options.some((option) => option.value === current)
  ) {
    options.unshift({ value: current, label: current });
  }
  return options;
}

/**
 * The settings of the selected stage, in sections that open and close: its name and type, the
 * agent and prompt of an agent task, and where the card goes for each result. Every change
 * rewrites the draft's `workflow.yaml` and leaves the keys the panel has no field for alone.
 */
export function StagePanel({
  files,
  index,
  stages,
  agents,
  editable,
  onChange,
  onClose,
}: {
  files: Files;
  index: number;
  stages: DraftStage[];
  agents: AgentInfo[];
  editable: boolean;
  onChange(files: Files): void;
  onClose(): void;
}) {
  const stage = stages[index];
  if (!stage) return null;
  const field = (name: string) =>
    typeof stage[name] === "string" ? (stage[name] as string) : "";
  const set = (name: string, value: string) =>
    onChange(setStageField(files, index, name, value));
  const on = (stage.on ?? {}) as Record<string, unknown>;
  const others = stages.filter((_, at) => at !== index);
  const inFile = !!field("prompt_file") || !!field("command");

  const route = (result: string) => {
    const current = on[result];
    const custom = current !== undefined && typeof current !== "string";
    const unset = ROUTE_LABELS[result]?.unset ?? "Default";
    return (
      <Select
        key={result}
        variant="field"
        label={ROUTE_LABELS[result]?.label ?? result}
        value={custom ? "custom" : (current ?? "")}
        disabled={!editable || custom}
        groups={[
          {
            label: "Default",
            options: [
              { value: "", label: unset },
              ...(custom ? [{ value: "custom", label: "A custom route" }] : []),
            ],
          },
          {
            label: "Stages",
            options: others.map((other) => ({
              value: other.id,
              label: other.id,
            })),
          },
          {
            label: "Otherwise",
            options: [
              { value: "stop", label: "Stop the workflow" },
              { value: "ask", label: "Ask me" },
            ],
          },
        ]}
        onValueChange={(target) =>
          onChange(setStageRoute(files, index, result, target))
        }
      />
    );
  };

  const items = [
    {
      value: "stage",
      title: "Stage",
      content: (
        <div className="wf-fields">
          <Field label="Name">
            <Input
              value={field("name")}
              disabled={!editable}
              autoComplete="off"
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field
            label="Internal name"
            description="Routes and documents name the stage by this."
          >
            <Input
              value={stage.id}
              disabled={!editable}
              autoComplete="off"
              onChange={(event) =>
                onChange(renameStage(files, index, event.target.value))
              }
            />
          </Field>
          <Field label="Type of stage">
            <Input value={kindLabel(stage.kind)} disabled readOnly />
          </Field>
          <Field label="Notes" optional>
            <Textarea
              rows={3}
              value={field("description")}
              disabled={!editable}
              placeholder="A note for people who edit this workflow. The agent does not read it."
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>
        </div>
      ),
    },
    ...(stage.kind === "prompt"
      ? [
          {
            value: "agent",
            title: "Agent",
            content: (
              <Select
                variant="field"
                label="Agent"
                value={field("agent")}
                disabled={!editable}
                placeholder={
                  agents.length ? "Choose an agent" : "No agent you can use"
                }
                groups={[
                  {
                    label: "Agents",
                    options: agentOptions(agents, stage.agent),
                  },
                ]}
                onValueChange={(agent) => set("agent", agent)}
              />
            ),
          },
          {
            value: "prompt",
            title: "Prompt",
            content: inFile ? (
              <p className="text-body-sm text-subtle">
                This stage reads its instructions from a file in the package,
                which this editor does not change.
              </p>
            ) : (
              <Field label="Prompt">
                <Textarea
                  rows={8}
                  variant="code"
                  value={field("prompt")}
                  disabled={!editable}
                  onChange={(event) => set("prompt", event.target.value)}
                />
              </Field>
            ),
          },
        ]
      : []),
    {
      value: "next",
      title: "What happens next",
      content: (
        <div className="wf-fields">
          {RESULTS.map(({ result }) => route(result))}
        </div>
      ),
    },
  ];

  return (
    <aside className="wf-panel" aria-label={`Settings of stage ${stage.id}`}>
      <InlineHeader
        title={String(stage.name || stage.id)}
        subtitle={`Stage ${index + 1} of ${stages.length}`}
        actions={
          <IconButton
            aria-label="Close stage settings"
            icon={<XIcon size="1rem" />}
            onClick={onClose}
          />
        }
      />
      <Accordion
        // The sections differ by kind, so a stage of another kind starts with its own all open.
        key={`${index}:${String(stage.kind)}`}
        variant="section"
        keepMounted
        defaultValue={items.map((item) => item.value)}
        items={items}
      />
    </aside>
  );
}

/**
 * What the panel shows while no stage is picked: the package's description and version, and
 * the files it holds besides the two the editor owns.
 */
export function WorkflowSettings({
  files,
  editable,
  onChange,
}: {
  files: Files;
  editable: boolean;
  onChange(files: Files): void;
}) {
  const info = packageInfo(files);
  const extra = Object.keys(files)
    .filter((path) => path !== PACKAGE_FILE && path !== WORKFLOW_FILE)
    .sort();
  return (
    <aside className="wf-panel" aria-label="Workflow settings">
      <InlineHeader
        title="Workflow settings"
        subtitle="Pick a stage to edit it."
      />
      <div className="wf-fields">
        <Field label="Description" optional>
          <Textarea
            rows={3}
            value={info.description}
            disabled={!editable}
            onChange={(event) =>
              onChange(setDescription(files, event.target.value))
            }
          />
        </Field>
        {info.version && (
          <p className="text-body-sm text-subtle">{`Version ${info.version}`}</p>
        )}
        <section aria-label="Files in this workflow">
          <p className="text-label">Files in this workflow</p>
          {extra.length === 0 ? (
            <p className="text-body-sm text-subtle">
              This workflow has no files besides its stages.
            </p>
          ) : (
            <ul className="wf-files">
              {extra.map((path) => (
                <li key={path}>
                  <code className="text-mono-sm">{path}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
