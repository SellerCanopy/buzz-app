import { useEffect, useRef, useState } from "react";
import {
  CaretLeftIcon,
  DotsThreeIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Callout } from "./Callout";
import type { Client } from "./engine/client";
import { EngineError, errorMessage } from "./engine/transport";
import type {
  AgentInfo,
  Finding,
  StageTemplate,
  Workflow,
} from "./gen/kiln/engine/v1/engine_pb";
import { Findings } from "./Findings";
import { SaveCopyDialog } from "./SaveCopyDialog";
import { CanvasLegend, StageCanvas, type StageMarks } from "./StageCanvas";
import { StagePanel, WorkflowSettings } from "./StagePanel";
import {
  appendStage,
  copyOf,
  duplicateStage,
  findingStage,
  moveStage,
  newStage,
  removeStage,
  sameFiles,
  stageFromTemplate,
  stagesOf,
  summary,
  type Files,
} from "./workflowDraft";

/**
 * A draft the page keeps while the editor is off screen, so Back and Forward return to the
 * text a person had typed. `base` is the hash the draft was opened at, which a save is checked
 * against, and `original` is the text at that hash.
 */
export type EditorDraft = { files: Files; original: Files; base: string };

type Loaded =
  | { status: "loading" }
  | {
      status: "ready";
      agents: AgentInfo[];
      templates: StageTemplate[];
      workflow: Workflow | undefined;
    }
  | { status: "error"; message: string };

type Confirm = "discard" | "leave" | "delete";

/** The agents a person may put on a stage: their own, or any when they are an admin. */
function usable(agents: AgentInfo[], isAdmin: boolean, me: string) {
  return agents.filter((agent) => isAdmin || agent.ownerPubkey === me);
}

/** The name a template shows in the Add stage menu. */
function templateLabel(template: StageTemplate): string {
  try {
    const stage = JSON.parse(template.stageJson) as { name?: unknown };
    return typeof stage.name === "string" && stage.name
      ? stage.name
      : template.id;
  } catch {
    return template.id;
  }
}

/** Hands the browser a file to save. */
function download(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/zip" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const CHECK_DELAY_MS = 400;

/**
 * One workflow as a canvas of its stages beside the settings of the stage that is picked.
 * The engine's checks run on the draft as it changes and their findings show under the canvas.
 * Saving checks the draft again and writes nothing when it has errors. A save made against a
 * version that has since changed is refused, and Reload reads the current one. Running cards
 * keep the version they started with.
 */
export function WorkflowEditor({
  client,
  name,
  canRun,
  isAdmin,
  me,
  restored,
  onDraft,
  onChanged,
  onCopied,
  onClose,
}: {
  client: Client;
  name: string;
  canRun: boolean;
  isAdmin: boolean;
  /** The signed-in person's pubkey. */
  me: string;
  restored: EditorDraft | undefined;
  /** Called with the draft as it stands, or undefined once it is saved or let go. */
  onDraft(draft: EditorDraft | undefined): void;
  /** A save or a delete changed what the workflow list shows. */
  onChanged(): void;
  /** A copy of this draft was saved under `name`, and takes this editor's place. */
  onCopied(name: string): void;
  onClose(): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [draft, setDraft] = useState<EditorDraft>();
  const [attempt, setAttempt] = useState(0);
  const [findings, setFindings] = useState<Finding[]>();
  const [selected, setSelected] = useState<number>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>();
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const keep = useRef<HTMLButtonElement>(null);
  // The draft the page kept is used once, for the first read. Reload reads the engine again.
  const [initial] = useState(restored);

  useEffect(() => {
    const abort = new AbortController();
    const reuse = attempt === 0 ? initial : undefined;
    setLoaded({ status: "loading" });
    Promise.all([
      reuse ? undefined : client.getWorkflowDraft(name, abort.signal),
      client.listAgents(abort.signal),
      client.listStageTemplates(abort.signal),
      client.listWorkflows(abort.signal),
    ])
      .then(([opened, agents, templates, list]) => {
        if (abort.signal.aborted) return;
        if (reuse) setDraft(reuse);
        else if (opened?.hash !== undefined) {
          const files = { ...opened.textFiles };
          setDraft({ files, original: files, base: opened.hash });
          setFindings(undefined);
          setStale(false);
          setError(undefined);
          setSelected(undefined);
        }
        setLoaded({
          status: "ready",
          agents: agents.agents,
          templates: templates.templates,
          workflow: list.workflows.find((w) => w.name === name),
        });
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        setLoaded({ status: "error", message: errorMessage(failure) });
      });
    return () => abort.abort();
  }, [client, name, attempt, initial]);

  // The checks run on the draft a moment after the last change, so typing does not call them
  // on every key.
  const files = draft?.files;
  const ready = loaded.status === "ready";
  useEffect(() => {
    if (!files || !ready) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      client
        .checkDraft({ name, files }, abort.signal)
        .then((checked) => {
          if (!abort.signal.aborted) {
            setFindings(checked.packages.flatMap((entry) => entry.findings));
          }
        })
        .catch(() => undefined);
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [client, name, files, ready]);

  const edit = (next: Files) => {
    if (!draft) return;
    const changed = { ...draft, files: next };
    setDraft(changed);
    onDraft(sameFiles(next, changed.original) ? undefined : changed);
  };

  const act = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const save = () =>
    draft &&
    act(async () => {
      setStale(false);
      try {
        const saved = await client.saveWorkflow(
          { name, files: draft.files },
          draft.base,
        );
        setDraft({
          files: draft.files,
          original: draft.files,
          base: saved.hash,
        });
        setLoaded((was) =>
          was.status === "ready"
            ? { ...was, workflow: saved.workflow ?? was.workflow }
            : was,
        );
        onDraft(undefined);
        onChanged();
      } catch (failure) {
        if (failure instanceof EngineError) {
          if (failure.code === "failed_precondition") setStale(true);
          // The refusal names the codes that failed, and the checks say where.
          if (failure.code === "invalid_argument") {
            const checked = await client
              .checkDraft({ name, files: draft.files })
              .catch(() => undefined);
            if (checked) {
              setFindings(checked.packages.flatMap((entry) => entry.findings));
            }
          }
        }
        throw failure;
      }
    });

  const saveCopy = (copyName: string, keepFiles: boolean) => {
    if (!draft || pending) return;
    setPending(true);
    setCopyError(undefined);
    client
      .saveWorkflow(
        { name: copyName, files: copyOf(draft.files, copyName, keepFiles) },
        "",
      )
      .then(() => {
        onDraft(undefined);
        onChanged();
        onCopied(copyName);
      })
      .catch((failure: unknown) => {
        setCopyError(errorMessage(failure));
        setPending(false);
      });
  };

  const remove = () =>
    act(async () => {
      try {
        await client.deleteWorkflow(name);
      } finally {
        setConfirm(undefined);
      }
      onDraft(undefined);
      onChanged();
      onClose();
    });

  const exportZip = () =>
    act(async () => {
      const exported = await client.exportWorkflow(name);
      download(`${name}.zip`, exported.zip);
    });

  const reload = () => {
    onDraft(undefined);
    setAttempt((n) => n + 1);
  };

  const dirty = !!draft && !sameFiles(draft.files, draft.original);
  const leave = () => {
    if (dirty) setConfirm("leave");
    else onClose();
  };

  const workflow = loaded.status === "ready" ? loaded.workflow : undefined;
  const own = !!workflow?.own;
  const agents =
    loaded.status === "ready" ? usable(loaded.agents, isAdmin, me) : [];
  const templates = loaded.status === "ready" ? loaded.templates : [];
  const stages = (draft && stagesOf(draft.files)) ?? [];
  const readable = !!draft && stagesOf(draft.files) !== undefined;
  const editable = canRun && !pending;
  const marks: StageMarks = new Map();
  for (const finding of findings ?? []) {
    const at = findingStage(finding);
    if (at === undefined) continue;
    if (finding.severity === "error") marks.set(at, "error");
    else if (finding.severity === "warning" && !marks.has(at)) {
      marks.set(at, "warning");
    }
  }
  const version = workflow?.version;
  const subtitle = !canRun
    ? "You can read this workflow, not change it."
    : workflow && !own
      ? `${workflow.builtin ? "Built in" : "Loaded from a folder"}${version ? `, version ${version}` : ""}. Save as copy to change it.`
      : `${version ? `Version ${version}. ` : ""}Cards that are running keep the version they started with.`;

  const add = (stage: Record<string, unknown> | undefined) => {
    if (!draft || !stage) return;
    edit(appendStage(draft.files, stage));
    setSelected(stages.length);
  };
  const agentFor = () => {
    const last = [...stages]
      .reverse()
      .find((stage) => stage.kind === "prompt" && stage.agent);
    return typeof last?.agent === "string"
      ? last.agent
      : (agents[0]?.name ?? "");
  };
  const fromTemplate = (template: StageTemplate) => {
    try {
      add(stageFromTemplate(template.stageJson, agentFor()));
    } catch {
      setError("That template could not be read.");
    }
  };

  const select = (at: number | undefined) =>
    setSelected(at !== undefined && at === selected ? undefined : at);
  const move = (at: number, by: number) => {
    if (!draft) return;
    edit(moveStage(draft.files, at, by));
    setSelected(at + by);
  };

  return (
    <div className="beehive-card-page">
      <div className="beehive-crumb">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to Workflows"
          onClick={leave}
        >
          <CaretLeftIcon size="1rem" aria-hidden="true" />
          Workflows
        </Button>
      </div>
      <Header
        title={name}
        subtitle={subtitle}
        actions={
          <>
            {findings && (
              <span
                className="beehive-status text-body-sm"
                data-tone={
                  findings.some((f) => f.severity === "error")
                    ? "danger"
                    : findings.some((f) => f.severity === "warning")
                      ? "warning"
                      : "success"
                }
              >
                {summary(findings)}
              </span>
            )}
            {canRun && (
              <>
                <Button
                  disabled={pending || !dirty}
                  onClick={() => setConfirm("discard")}
                >
                  Discard changes
                </Button>
                <Button
                  disabled={pending || !draft || !readable}
                  onClick={() => {
                    setCopyError(undefined);
                    setCopying(true);
                  }}
                >
                  Save as copy
                </Button>
                <Button
                  variant="prominent"
                  loading={pending && !copying}
                  disabled={pending || !dirty || !own}
                  onClick={() => void save()}
                >
                  Save version
                </Button>
                <MenuRoot>
                  <MenuTrigger
                    render={
                      <IconButton
                        aria-label="More actions"
                        icon={<DotsThreeIcon size="1rem" />}
                      />
                    }
                  />
                  <MenuPopup>
                    <MenuItem onClick={() => void exportZip()}>
                      Export as zip
                    </MenuItem>
                    {own && (
                      <MenuItem
                        tone="danger"
                        onClick={() => setConfirm("delete")}
                      >
                        Delete workflow
                      </MenuItem>
                    )}
                  </MenuPopup>
                </MenuRoot>
              </>
            )}
          </>
        }
      />
      {stale && (
        <Callout
          tone="warning"
          title="This workflow changed since you opened it"
          actions={<Button onClick={reload}>Reload</Button>}
        >
          Someone saved a newer version. Reload to see it before you save.
          Reloading replaces what you changed here.
        </Callout>
      )}
      {error && !stale && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <LoadingRegion
        pending={loaded.status === "loading"}
        label="Loading workflow…"
        feedback={
          loaded.status === "error" ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {loaded.message}
              </p>
              <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {loaded.status === "ready" && draft && !readable && (
          <p role="alert" className="text-danger">
            This workflow's stages could not be read, so it cannot be edited
            here.
          </p>
        )}
        {loaded.status === "ready" && draft && readable && (
          <div className="wf-split">
            <div className="wf-main">
              <div className="wf-toolbar">
                {canRun && (
                  <MenuRoot>
                    <MenuTrigger
                      render={
                        <Button disabled={!editable}>
                          <PlusIcon size="1rem" aria-hidden="true" />
                          Add stage
                        </Button>
                      }
                    />
                    <MenuPopup>
                      <MenuGroup>
                        <MenuGroupLabel>Add a stage</MenuGroupLabel>
                        <MenuItem
                          onClick={() => add(newStage("prompt", agentFor()))}
                        >
                          Agent task
                        </MenuItem>
                        <MenuItem onClick={() => add(newStage("approval", ""))}>
                          Approval
                        </MenuItem>
                        <MenuItem onClick={() => add(newStage("wait", ""))}>
                          Wait
                        </MenuItem>
                        <MenuItem onClick={() => add(newStage("action", ""))}>
                          Automatic job
                        </MenuItem>
                      </MenuGroup>
                      {templates.length > 0 && (
                        <MenuGroup>
                          <MenuGroupLabel>From a template</MenuGroupLabel>
                          {templates.map((template) => (
                            <MenuItem
                              key={template.id}
                              onClick={() => fromTemplate(template)}
                            >
                              {templateLabel(template)}
                            </MenuItem>
                          ))}
                        </MenuGroup>
                      )}
                    </MenuPopup>
                  </MenuRoot>
                )}
                <CanvasLegend />
              </div>
              <StageCanvas
                stages={stages}
                selected={selected}
                marks={marks}
                editable={editable}
                onSelect={select}
                onMove={move}
                onDuplicate={(at) => {
                  edit(duplicateStage(draft.files, at));
                  setSelected(at + 1);
                }}
                onRemove={(at) => {
                  edit(removeStage(draft.files, at));
                  setSelected(undefined);
                }}
              />
              <section className="wf-findings" aria-label="Findings">
                <div className="wf-findings-head">
                  <p className="text-label">Findings</p>
                  {findings && (
                    <p className="text-body-sm text-subtle">
                      {summary(findings)}
                    </p>
                  )}
                </div>
                {findings && findings.length === 0 && (
                  <p className="text-body-sm text-subtle">
                    The checks found no problems.
                  </p>
                )}
                <Findings
                  label={name}
                  findings={findings ?? []}
                  scope={(finding) => {
                    const at = findingStage(finding);
                    return at === undefined ? undefined : stages[at]?.id;
                  }}
                />
              </section>
            </div>
            {selected !== undefined && stages[selected] ? (
              <StagePanel
                files={draft.files}
                index={selected}
                stages={stages}
                agents={agents}
                editable={editable}
                onChange={edit}
                onClose={() => setSelected(undefined)}
              />
            ) : (
              <WorkflowSettings
                files={draft.files}
                editable={editable}
                onChange={edit}
              />
            )}
          </div>
        )}
      </LoadingRegion>
      {copying && draft && (
        <SaveCopyDialog
          initialName={`${name}-copy`.slice(0, 32)}
          pending={pending}
          error={copyError}
          onSave={saveCopy}
          onClose={() => setCopying(false)}
        />
      )}
      {(confirm === "discard" || confirm === "leave") && (
        <AlertDialog
          title="Discard your changes?"
          description={
            confirm === "leave"
              ? "What you changed in this workflow is not saved, and closing it throws that away."
              : "What you changed in this workflow is not saved, and this puts it back as it was opened."
          }
          initialFocus={keep}
          onClose={() => setConfirm(undefined)}
          actions={
            <>
              <Button ref={keep} onClick={() => setConfirm(undefined)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const leaving = confirm === "leave";
                  setConfirm(undefined);
                  onDraft(undefined);
                  if (leaving) onClose();
                  else {
                    setDraft((was) => was && { ...was, files: was.original });
                    setSelected(undefined);
                    setStale(false);
                    setError(undefined);
                  }
                }}
              >
                Discard
              </Button>
            </>
          }
        />
      )}
      {confirm === "delete" && (
        <AlertDialog
          title={`Delete ${name}?`}
          description="Cards that already ran on it keep the version they used. A card that still uses it, or an intake rule that names it, stops the delete."
          pending={pending}
          initialFocus={keep}
          onClose={() => setConfirm(undefined)}
          actions={
            <>
              <Button
                ref={keep}
                disabled={pending}
                onClick={() => setConfirm(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={pending}
                onClick={() => void remove()}
              >
                Delete workflow
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
