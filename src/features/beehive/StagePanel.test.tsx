// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { StagePanel, WorkflowSettings } from "./StagePanel";
import {
  stagesOf,
  PACKAGE_FILE,
  WORKFLOW_FILE,
  type Files,
} from "./workflowDraft";

afterEach(cleanup);

const filesOf = (stages: object[], extra: Files = {}): Files => ({
  [PACKAGE_FILE]: JSON.stringify({ name: "rpi", version: "3" }),
  [WORKFLOW_FILE]: JSON.stringify({ version: 2, stages }),
  ...extra,
});

/** The panel over files it rewrites, as the editor holds them. */
function panel(
  initial: Files,
  index: number,
  props: { editable?: boolean } = {},
) {
  const seen: Files[] = [];
  const onClose = vi.fn();
  function Host() {
    const [files, setFiles] = useState(initial);
    return (
      <StagePanel
        files={files}
        index={index}
        stages={stagesOf(files) ?? []}
        agents={[{ name: "builder" } as never]}
        editable={props.editable ?? true}
        onChange={(next) => {
          seen.push(next);
          setFiles(next);
        }}
        onClose={onClose}
      />
    );
  }
  render(<Host />);
  return { seen, onClose };
}

const idsOf = (files: Files | undefined) =>
  stagesOf(files ?? {})?.map((stage) => stage.id);

it("shows the kind of stage as read-only text", () => {
  panel(filesOf([{ id: "plan", kind: "prompt", agent: "builder" }]), 0);
  const kind = screen.getByRole("textbox", { name: "Type of stage" });
  expect(kind).toHaveValue("Agent task");
  expect(kind).toBeDisabled();
  expect(kind).toHaveAttribute("readonly");
  expect(screen.getByText("Stage 1 of 1")).toBeVisible();
});

it("reads a prompt from a file without offering to change it, and so does a stage that runs a command", () => {
  panel(
    filesOf([{ id: "plan", kind: "prompt", prompt_file: "prompts/plan.md" }]),
    0,
  );
  expect(
    screen.getByText(/reads its instructions from a file in the package/),
  ).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();
  cleanup();
  panel(filesOf([{ id: "plan", kind: "prompt", command: "make test" }]), 0);
  expect(
    screen.getByText(/reads its instructions from a file in the package/),
  ).toBeVisible();
});

it("offers the prompt and the agent only to an agent task", () => {
  panel(filesOf([{ id: "review", kind: "approval" }]), 0);
  expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Agent" })).toBeNull();
  expect(
    screen.getByRole("combobox", { name: "When it passes" }),
  ).toBeVisible();
});

it("writes a typed prompt into the stage and nothing else", async () => {
  const view = panel(
    filesOf([{ id: "plan", kind: "prompt", agent: "builder", prompt: "" }]),
    0,
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Go");
  expect(stagesOf(view.seen.at(-1) ?? {})?.[0]).toMatchObject({
    id: "plan",
    agent: "builder",
    prompt: "Go",
  });
});

it("renames a stage and lets a name another stage has through, for the checks to flag", async () => {
  const view = panel(
    filesOf([
      { id: "plan", kind: "prompt", agent: "builder", prompt: "x" },
      { id: "review", kind: "approval", on: { failed: "plan" } },
    ]),
    0,
  );
  const name = screen.getByRole("textbox", { name: "Internal name" });
  await userEvent.clear(name);
  await userEvent.type(name, "review");
  // Both stages now carry the id, and the route that named the first follows the rename.
  expect(idsOf(view.seen.at(-1))).toEqual(["review", "review"]);
  expect(stagesOf(view.seen.at(-1) ?? {})?.[1]?.on).toEqual({
    failed: "review",
  });
});

it("shows a route another editor wrote as a custom route that cannot be changed here", () => {
  panel(
    filesOf([
      { id: "a", kind: "wait", on: { passed: { when: "x", to: "b" } } },
      { id: "b", kind: "wait" },
    ]),
    0,
  );
  const route = screen.getByRole("combobox", { name: "When it passes" });
  expect(route).toBeDisabled();
  expect(route).toHaveTextContent("A custom route");
  expect(screen.getByRole("combobox", { name: "When it fails" })).toBeEnabled();
});

it("sets where a result goes, and changes it again", async () => {
  const view = panel(
    filesOf([
      { id: "a", kind: "wait" },
      { id: "b", kind: "wait" },
    ]),
    0,
  );
  await userEvent.click(
    screen.getByRole("combobox", { name: "When it fails" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "b" }));
  expect(stagesOf(view.seen.at(-1) ?? {})?.[0]?.on).toEqual({ failed: "b" });
  await userEvent.click(
    screen.getByRole("combobox", { name: "When it fails" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Ask me" }));
  expect(stagesOf(view.seen.at(-1) ?? {})?.[0]?.on).toEqual({ failed: "ask" });
});

it("changes nothing when the workflow cannot be edited", () => {
  panel(
    filesOf([{ id: "plan", kind: "prompt", agent: "builder", prompt: "x" }]),
    0,
    { editable: false },
  );
  for (const name of [/^Name/, /^Internal name/, /^Prompt/, /^Notes/])
    expect(screen.getByRole("textbox", { name })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Agent" })).toBeDisabled();
  expect(
    screen.getByRole("combobox", { name: "When it passes" }),
  ).toBeDisabled();
});

it("shows nothing for a position that holds no stage, and closes from its button", async () => {
  const gone = panel(filesOf([{ id: "a", kind: "wait" }]), 4);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(gone.onClose).not.toHaveBeenCalled();
  cleanup();
  const view = panel(filesOf([{ id: "a", kind: "wait" }]), 0);
  await userEvent.click(
    screen.getByRole("button", { name: "Close stage settings" }),
  );
  expect(view.onClose).toHaveBeenCalledTimes(1);
});

it("lists the files a package holds besides its stages, and writes the description it is given", async () => {
  const seen: Files[] = [];
  function Host() {
    const [files, setFiles] = useState(
      filesOf([{ id: "a", kind: "wait" }], {
        "prompts/zeta.md": "z",
        "prompts/alpha.md": "a",
      }),
    );
    return (
      <WorkflowSettings
        files={files}
        editable
        onChange={(next) => {
          seen.push(next);
          setFiles(next);
        }}
      />
    );
  }
  render(<Host />);
  expect(screen.getByText("Version 3")).toBeVisible();
  const listed = within(
    screen.getByRole("region", { name: "Files in this workflow" }),
  ).getAllByRole("listitem");
  expect(listed.map((item) => item.textContent)).toEqual([
    "prompts/alpha.md",
    "prompts/zeta.md",
  ]);
  await userEvent.type(
    screen.getByRole("textbox", { name: /Description/ }),
    "Ships it",
  );
  expect(JSON.parse(seen.at(-1)?.[PACKAGE_FILE] ?? "{}")).toMatchObject({
    description: "Ships it",
    version: "3",
  });
});

it("says a workflow has no files besides its stages", () => {
  render(
    <WorkflowSettings
      files={filesOf([{ id: "a", kind: "wait" }])}
      editable={false}
      onChange={() => {}}
    />,
  );
  expect(
    screen.getByText("This workflow has no files besides its stages."),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: /Description/ })).toBeDisabled();
});
