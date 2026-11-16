// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { StageCanvas, type StageMarks } from "./StageCanvas";
import type { DraftStage } from "./workflowDraft";

afterEach(cleanup);

const stages = (): DraftStage[] => [
  { id: "plan", kind: "prompt", agent: "builder" },
  {
    id: "review",
    kind: "approval",
    approval: { artifacts: ["plan", "notes"] },
  },
  { id: "ship", kind: "action", action: "open_pull_request" },
];

function show(
  props: {
    stages?: DraftStage[];
    selected?: number;
    marks?: StageMarks;
    editable?: boolean;
  } = {},
) {
  const handlers = {
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onDuplicate: vi.fn(),
    onRemove: vi.fn(),
  };
  const view = render(
    <StageCanvas
      stages={props.stages ?? stages()}
      selected={props.selected}
      marks={props.marks ?? new Map()}
      editable={props.editable ?? true}
      {...handlers}
    />,
  );
  return { ...handlers, container: view.container };
}

it("names each stage with its kind, and the line its tag shows", () => {
  show();
  const nodes = within(screen.getByRole("list", { name: "Stages" }));
  expect(
    nodes.getByRole("button", { name: "plan, Agent task" }),
  ).toHaveTextContent("builder");
  expect(
    nodes.getByRole("button", { name: "review, Approval" }),
  ).toHaveTextContent("plan, notes");
  expect(
    nodes.getByRole("button", { name: "ship, Automatic job" }),
  ).toHaveTextContent("open pull request");
});

it("reads a kind it does not know as it is, with no tag", () => {
  show({ stages: [{ id: "odd", kind: "teleport" }] });
  expect(screen.getByRole("button", { name: "odd, teleport" })).toBeVisible();
  expect(document.querySelector(".beehive-tag")).toBeNull();
});

it("says which stages the checks found an error or a warning in", () => {
  show({
    marks: new Map<number, "error" | "warning">([
      [0, "error"],
      [2, "warning"],
    ]),
  });
  expect(
    screen.getByRole("button", { name: "plan, Agent task, has an error" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: "ship, Automatic job, has a warning",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "review, Approval" }),
  ).toBeVisible();
});

it("picks a stage when its node is pressed", async () => {
  const view = show();
  await userEvent.click(
    screen.getByRole("button", { name: "review, Approval" }),
  );
  expect(view.onSelect).toHaveBeenCalledWith(1);
});

it("offers the tools only on the selected stage of an editable workflow", () => {
  show();
  expect(screen.queryByRole("button", { name: "Move earlier" })).toBeNull();
  cleanup();
  show({ selected: 1, editable: false });
  expect(screen.queryByRole("button", { name: "Move earlier" })).toBeNull();
  cleanup();
  show({ selected: 1 });
  for (const name of [
    "Move earlier",
    "Move later",
    "Duplicate stage",
    "Remove stage",
  ])
    expect(screen.getByRole("button", { name })).toBeEnabled();
});

it("cannot move the first stage earlier or the last stage later", () => {
  show({ selected: 0 });
  expect(screen.getByRole("button", { name: "Move earlier" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move later" })).toBeEnabled();
  cleanup();
  show({ selected: 2 });
  expect(screen.getByRole("button", { name: "Move later" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move earlier" })).toBeEnabled();
});

it("keeps the last stage: a workflow of one cannot lose it", () => {
  show({ stages: [{ id: "only", kind: "wait" }], selected: 0 });
  expect(screen.getByRole("button", { name: "Remove stage" })).toBeDisabled();
});

it("reports a move, a copy and a removal against the selected stage", async () => {
  const view = show({ selected: 1 });
  await userEvent.click(screen.getByRole("button", { name: "Move earlier" }));
  await userEvent.click(screen.getByRole("button", { name: "Move later" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Duplicate stage" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove stage" }));
  expect(view.onMove.mock.calls).toEqual([
    [1, -1],
    [1, 1],
  ]);
  expect(view.onDuplicate).toHaveBeenCalledWith(1);
  expect(view.onRemove).toHaveBeenCalledWith(1);
});

it("draws no arc for stages that go on to the next one", () => {
  const view = show({
    stages: [
      { id: "a", kind: "wait", on: { passed: "b" } },
      { id: "b", kind: "wait", on: { passed: "c" } },
      { id: "c", kind: "wait" },
    ],
  });
  expect(view.container.querySelector("svg")).toBeNull();
});

it("draws an arc for a loop back and for a route that skips ahead, by the result it is taken on", () => {
  const view = show({
    stages: [
      { id: "a", kind: "wait", on: { failed: "c" } },
      { id: "b", kind: "wait", on: { needs_work: "a", passed: "c" } },
      { id: "c", kind: "wait", on: { passed: "missing" } },
    ],
  });
  const arcs = [...view.container.querySelectorAll(".wf-arc")].map((path) =>
    path.getAttribute("data-result"),
  );
  // a skips to c, and b loops back to a. Routes to the next stage or to no stage have none.
  expect(arcs.sort()).toEqual(["failed", "needs_work"]);
});

it("names the stage by its name when it has one", () => {
  show({ stages: [{ id: "plan", name: "Plan it", kind: "wait" }] });
  expect(screen.getByText("Plan it")).toBeVisible();
});
