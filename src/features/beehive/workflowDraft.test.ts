import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { FindingSchema } from "./gen/kiln/engine/v1/engine_pb";
import {
  appendStage,
  copyOf,
  duplicateStage,
  findingStage,
  moveStage,
  newStage,
  packageInfo,
  removeStage,
  renameStage,
  sameFiles,
  setDescription,
  setStageField,
  setStageRoute,
  stageFromTemplate,
  stagesOf,
  summary,
  PACKAGE_FILE,
  WORKFLOW_FILE,
  type Files,
} from "./workflowDraft";

const files = (): Files => ({
  [PACKAGE_FILE]: JSON.stringify({ name: "w", version: "2", description: "d" }),
  [WORKFLOW_FILE]: JSON.stringify({
    version: 2,
    stages: [
      { id: "a", kind: "prompt", agent: "x", prompt: "one", inputs: [] },
      { id: "b", kind: "approval", on: { needs_work: "a" } },
      { id: "c", kind: "action", action: "open_pull_request" },
    ],
  }),
  "prompts/a.md": "text",
});

const ids = (f: Files) => stagesOf(f)?.map((s) => s.id);

it("reads the stages, and says nothing for a file that is not a workflow", () => {
  expect(ids(files())).toEqual(["a", "b", "c"]);
  expect(stagesOf({ [WORKFLOW_FILE]: "not json" })).toBeUndefined();
  expect(stagesOf({ [WORKFLOW_FILE]: "[]" })).toBeUndefined();
  expect(stagesOf({})).toBeUndefined();
});

it("changes one field and keeps the keys the editor has no field for", () => {
  const next = setStageField(files(), 0, "prompt", "two");
  expect(stagesOf(next)?.[0]).toMatchObject({ prompt: "two", inputs: [] });
  expect(
    stagesOf(setStageField(next, 0, "prompt", ""))?.[0],
  ).not.toHaveProperty("prompt");
  // Files that are not the workflow are not touched, and a bad index changes nothing.
  expect(next["prompts/a.md"]).toBe("text");
  expect(stagesOf(setStageField(files(), 9, "prompt", "x"))).toHaveLength(3);
});

it("sets and clears a route, and drops an empty route table", () => {
  const set = setStageRoute(files(), 0, "failed", "stop");
  expect(stagesOf(set)?.[0]?.on).toEqual({ failed: "stop" });
  const cleared = setStageRoute(files(), 1, "needs_work", "");
  expect(stagesOf(cleared)?.[1]).not.toHaveProperty("on");
});

it("renames a stage and the routes that named it", () => {
  const next = renameStage(files(), 0, "first");
  expect(ids(next)).toEqual(["first", "b", "c"]);
  expect(stagesOf(next)?.[1]?.on).toEqual({ needs_work: "first" });
});

it("adds a stage under an id no stage has, and moves, copies and removes stages", () => {
  const added = appendStage(files(), { id: "a", kind: "wait" });
  expect(ids(added)).toEqual(["a", "b", "c", "a_2"]);
  expect(ids(moveStage(files(), 2, -1))).toEqual(["a", "c", "b"]);
  expect(ids(moveStage(files(), 0, -1))).toEqual(["a", "b", "c"]);
  const copied = duplicateStage(files(), 1);
  expect(ids(copied)).toEqual(["a", "b", "b_copy", "c"]);
  // The copy does not inherit routes, and the original keeps its own.
  expect(stagesOf(copied)?.[2]).not.toHaveProperty("on");
  const removed = removeStage(files(), 0);
  expect(ids(removed)).toEqual(["b", "c"]);
  // A route to the removed stage is cleared rather than left pointing nowhere.
  expect(stagesOf(removed)?.[0]).not.toHaveProperty("on");
});

it("builds the stages the Add stage menu offers and fills a template", () => {
  expect(newStage("prompt", "x")).toMatchObject({ kind: "prompt", agent: "x" });
  expect(newStage("prompt", "")).not.toHaveProperty("agent");
  expect(newStage("wait", "")).toMatchObject({ kind: "wait" });
  const stage = stageFromTemplate(
    JSON.stringify({
      id: "implement",
      kind: "prompt",
      agent: "builder",
      description: "Makes the change.",
    }),
    "mine",
  );
  expect(stage).toEqual({ id: "implement", kind: "prompt", agent: "mine" });
  expect(stageFromTemplate("[]", "mine")).toBeUndefined();
});

it("copies a draft under a new name, with or without its other files", () => {
  const bare = copyOf(files(), "w-copy", false);
  expect(Object.keys(bare).sort()).toEqual([PACKAGE_FILE, WORKFLOW_FILE]);
  expect(JSON.parse(bare[PACKAGE_FILE] ?? "")).toMatchObject({
    name: "w-copy",
    version: "2",
  });
  const full = copyOf(files(), "w-copy", true);
  expect(full["prompts/a.md"]).toBe("text");
});

it("reads and changes the package's description", () => {
  expect(packageInfo(files())).toEqual({ description: "d", version: "2" });
  expect(packageInfo({})).toEqual({ description: "", version: "" });
  const next = setDescription(files(), "new");
  expect(packageInfo(next).description).toBe("new");
  expect(
    JSON.parse(setDescription(files(), "")[PACKAGE_FILE] ?? ""),
  ).not.toHaveProperty("description");
});

it("finds the stage a finding is about and sums the findings up", () => {
  const finding = (path: string, severity: string) =>
    create(FindingSchema, { path, severity, code: "c", message: "m" });
  expect(
    findingStage(finding("workflow.yaml:stages[2].on.passed", "error")),
  ).toBe(2);
  expect(findingStage(finding("kiln-package.yaml", "error"))).toBeUndefined();
  expect(summary([])).toBe("No problems");
  expect(
    summary([
      finding("a", "error"),
      finding("b", "warning"),
      finding("c", "warning"),
      finding("d", "note"),
    ]),
  ).toBe("1 error, 2 warnings");
  expect(sameFiles(files(), files())).toBe(true);
  expect(sameFiles(files(), { ...files(), extra: "x" })).toBe(false);
});
