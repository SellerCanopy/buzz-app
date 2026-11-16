import type { Finding } from "./gen/kiln/engine/v1/engine_pb";

export const PACKAGE_FILE = "kiln-package.yaml";
export const WORKFLOW_FILE = "workflow.yaml";

/** A package's files by path, as text. */
export type Files = Record<string, string>;

/**
 * One stage as the editor holds it. The engine's other keys (inputs, repeats, limits and the
 * rest) ride along untouched, so an edit never drops what the editor has no field for.
 */
export type DraftStage = Record<string, unknown> & { id: string };

type Document = Record<string, unknown> & { stages: DraftStage[] };

function document(text: string | undefined): Document | undefined {
  if (text === undefined) return;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    return Array.isArray((value as { stages?: unknown }).stages)
      ? (value as Document)
      : undefined;
  } catch {
    return;
  }
}

/** The stages `workflow.yaml` holds, or undefined when it is not a workflow the editor can read. */
export function stagesOf(files: Files): DraftStage[] | undefined {
  return document(files[WORKFLOW_FILE])?.stages;
}

function write(files: Files, change: (doc: Document) => void): Files {
  const doc = document(files[WORKFLOW_FILE]);
  if (!doc) return files;
  change(doc);
  return { ...files, [WORKFLOW_FILE]: JSON.stringify(doc, null, 2) };
}

/** An id no stage uses yet, starting from `wanted`. */
function freeId(stages: DraftStage[], wanted: string): string {
  const taken = new Set(stages.map((stage) => stage.id));
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted}_${n}`)) n += 1;
  return `${wanted}_${n}`;
}

/** `files` with one field of the stage at `index` changed. A field set to "" is removed. */
export function setStageField(
  files: Files,
  index: number,
  field: string,
  value: string,
): Files {
  return write(files, (doc) => {
    const stage = doc.stages[index];
    if (!stage) return;
    if (value === "") delete stage[field];
    else stage[field] = value;
  });
}

/** `files` with the stage at `index` renamed to `id`, and the routes that named it following. */
export function renameStage(files: Files, index: number, id: string): Files {
  return write(files, (doc) => {
    const stage = doc.stages[index];
    if (!stage) return;
    const old = stage.id;
    stage.id = id;
    for (const other of doc.stages) {
      const on = other.on as Record<string, unknown> | undefined;
      if (!on) continue;
      for (const [result, target] of Object.entries(on)) {
        if (target === old) on[result] = id;
      }
    }
  });
}

/** `files` with where the stage at `index` sends `result` changed. "" takes the default. */
export function setStageRoute(
  files: Files,
  index: number,
  result: string,
  target: string,
): Files {
  return write(files, (doc) => {
    const stage = doc.stages[index];
    if (!stage) return;
    const on = { ...((stage.on as Record<string, string> | undefined) ?? {}) };
    if (target === "") delete on[result];
    else on[result] = target;
    if (Object.keys(on).length) stage.on = on;
    else delete stage.on;
  });
}

/** `files` with `stage` added at the end under an id no other stage has. */
export function appendStage(
  files: Files,
  stage: Record<string, unknown>,
): Files {
  return write(files, (doc) => {
    const id = freeId(doc.stages, String(stage.id ?? "stage"));
    doc.stages.push({ ...stage, id });
  });
}

/** `files` with the stage at `index` moved by `by` places, kept inside the list. */
export function moveStage(files: Files, index: number, by: number): Files {
  return write(files, (doc) => {
    const to = index + by;
    if (to < 0 || to >= doc.stages.length) return;
    const [stage] = doc.stages.splice(index, 1);
    if (stage) doc.stages.splice(to, 0, stage);
  });
}

/** `files` with a copy of the stage at `index` right after it. */
export function duplicateStage(files: Files, index: number): Files {
  return write(files, (doc) => {
    const stage = doc.stages[index];
    if (!stage) return;
    const copy = structuredClone(stage);
    copy.id = freeId(doc.stages, `${stage.id}_copy`);
    // A route to the original would now have two stages that look alike.
    delete copy.on;
    doc.stages.splice(index + 1, 0, copy);
  });
}

/** `files` without the stage at `index`. Routes that named it are cleared. */
export function removeStage(files: Files, index: number): Files {
  return write(files, (doc) => {
    const [gone] = doc.stages.splice(index, 1);
    if (!gone) return;
    for (const stage of doc.stages) {
      const on = stage.on as Record<string, string> | undefined;
      if (!on) continue;
      for (const [result, target] of Object.entries(on)) {
        if (target === gone.id) delete on[result];
      }
      if (!Object.keys(on).length) delete stage.on;
    }
  });
}

/**
 * The kinds of stage, in the order the Add stage menu lists them. `label` is the editor's word for
 * the kind, as the canvas and the menu show it; `listLabel` is the word the Workflows list uses.
 */
export const STAGE_KINDS = [
  { kind: "prompt", label: "Agent task", listLabel: "Prompt" },
  { kind: "approval", label: "Approval", listLabel: "Approval" },
  { kind: "wait", label: "Wait", listLabel: "Wait" },
  { kind: "action", label: "Automatic job", listLabel: "Action" },
] as const;

export type StageKind = (typeof STAGE_KINDS)[number]["kind"];

/** What a kind of stage is called, in the editor or in the Workflows list. An unknown kind reads as it is. */
export function kindLabel(kind: unknown, where: "editor" | "list" = "editor") {
  const known = STAGE_KINDS.find((entry) => entry.kind === kind);
  if (!known) return String(kind ?? "");
  return where === "list" ? known.listLabel : known.label;
}

/** A stage of a kind the Add stage menu offers. Only a prompt stage uses `agent`. */
export function newStage(
  kind: StageKind,
  agent: string,
): Record<string, unknown> {
  switch (kind) {
    case "prompt":
      return { id: "stage", kind, ...(agent ? { agent } : {}), prompt: "" };
    case "approval":
      return { id: "approval", kind, approval: { artifacts: [] } };
    case "wait":
      return { id: "wait", kind, wait: { pull_request: "merged" } };
    case "action":
      return { id: "action", kind, action: "open_pull_request" };
  }
}

/** The stage a template holds, given the agent a prompt stage runs on. */
export function stageFromTemplate(json: string, agent: string) {
  const stage: unknown = JSON.parse(json);
  if (!stage || typeof stage !== "object" || Array.isArray(stage)) return;
  const template = stage as Record<string, unknown>;
  // A template names a stock agent; the person's own agent takes its place.
  if (template.kind === "prompt" && agent) template.agent = agent;
  // The description is the template's own, not part of a workflow's stage.
  delete template.description;
  return template;
}

/** `files` renamed to `name`, keeping only the package and workflow files unless told to keep all. */
export function copyOf(files: Files, name: string, keepFiles: boolean): Files {
  const packageText = files[PACKAGE_FILE];
  let renamed = packageText ?? "";
  try {
    const parsed: unknown = JSON.parse(renamed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      renamed = JSON.stringify({ ...parsed, name }, null, 2);
    }
  } catch {
    // The engine refuses a package file it cannot read, and says why.
  }
  const kept = keepFiles
    ? files
    : Object.fromEntries(
        Object.entries(files).filter(
          ([path]) => path === PACKAGE_FILE || path === WORKFLOW_FILE,
        ),
      );
  return { ...kept, [PACKAGE_FILE]: renamed };
}

/** What `kiln-package.yaml` says about the package, or an empty record when it cannot be read. */
export function packageInfo(files: Files): {
  description: string;
  version: string;
} {
  try {
    const parsed: unknown = JSON.parse(files[PACKAGE_FILE] ?? "");
    const info = (parsed ?? {}) as Record<string, unknown>;
    return {
      description: typeof info.description === "string" ? info.description : "",
      version: typeof info.version === "string" ? info.version : "",
    };
  } catch {
    return { description: "", version: "" };
  }
}

/** `files` with the package's description changed. An empty one is removed. */
export function setDescription(files: Files, description: string): Files {
  try {
    const parsed: unknown = JSON.parse(files[PACKAGE_FILE] ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return files;
    }
    const info = { ...(parsed as Record<string, unknown>) };
    if (description === "") delete info.description;
    else info.description = description;
    return { ...files, [PACKAGE_FILE]: JSON.stringify(info, null, 2) };
  } catch {
    return files;
  }
}

const STAGE_PATH = /^workflow\.yaml:stages\[(\d+)\]/;

/** The stage a finding is about, by position, or undefined for a finding about the package. */
export function findingStage(finding: Finding): number | undefined {
  const match = STAGE_PATH.exec(finding.path);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** "1 error, 1 warning", or "No problems" when the checks found none. */
export function summary(findings: Finding[]): string {
  const count = (severity: string) =>
    findings.filter((f) => f.severity === severity).length;
  const parts = [
    [count("error"), "error"],
    [count("warning"), "warning"],
  ]
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "No problems";
}

/** True when the two sets of files hold the same text. */
export function sameFiles(a: Files, b: Files): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
}
