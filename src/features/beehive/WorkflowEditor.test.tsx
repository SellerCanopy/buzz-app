// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { Client } from "./engine/client";
import { EngineError } from "./engine/transport";
import {
  CheckWorkflowResponseSchema,
  GetWorkflowDraftResponseSchema,
  ListAgentsResponseSchema,
  ListStageTemplatesResponseSchema,
  ListWorkflowsResponseSchema,
  SaveWorkflowResponseSchema,
  type Finding,
} from "./gen/kiln/engine/v1/engine_pb";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { WorkflowEditor, type EditorDraft } from "./WorkflowEditor";

afterEach(cleanup);

const ME = "aa".repeat(32);
const OTHER = "bb".repeat(32);

const files = () => ({
  "kiln-package.yaml": JSON.stringify({ name: "release", version: "3" }),
  "workflow.yaml": JSON.stringify({
    version: 2,
    stages: [
      { id: "plan", kind: "prompt", agent: "mine", prompt: "Plan it." },
      { id: "review", kind: "approval", approval: { artifacts: ["plan"] } },
    ],
  }),
});

const finding = (fields: Partial<Finding> = {}) => ({
  path: "workflow.yaml:stages[0].on.passed",
  code: "route_target_unknown",
  severity: "error",
  message: "Stage plan routes passed to a stage that does not exist.",
  ...fields,
});

type Options = {
  own?: boolean;
  builtin?: boolean;
  findings?: ReturnType<typeof finding>[];
};

function engine(options: Options = {}) {
  const { own = true, builtin = false, findings = [] } = options;
  const calls = {
    getWorkflowDraft: vi.fn(async () =>
      create(GetWorkflowDraftResponseSchema, {
        hash: "h1",
        textFiles: files(),
      }),
    ),
    listAgents: vi.fn(async () =>
      create(ListAgentsResponseSchema, {
        agents: [
          { name: "mine", pubkey: "01", ownerPubkey: ME },
          { name: "other-mine", pubkey: "03", ownerPubkey: ME },
          { name: "theirs", pubkey: "02", ownerPubkey: OTHER },
        ],
      }),
    ),
    listStageTemplates: vi.fn(async () =>
      create(ListStageTemplatesResponseSchema, {
        templates: [
          {
            id: "research",
            stageJson: JSON.stringify({
              id: "research",
              name: "Research",
              kind: "prompt",
              agent: "builder",
              description: "Reads the code.",
              prompt: "Look.",
            }),
          },
        ],
      }),
    ),
    listWorkflows: vi.fn(async () =>
      create(ListWorkflowsResponseSchema, {
        workflows: [{ name: "release", version: "3", own, builtin, ok: true }],
      }),
    ),
    checkDraft: vi.fn(async (_draft: unknown, _signal?: AbortSignal) =>
      create(CheckWorkflowResponseSchema, {
        packages: [{ name: "release", path: "saved/release", findings }],
      }),
    ),
    saveWorkflow: vi.fn(async (_draft: unknown, _base: string) =>
      create(SaveWorkflowResponseSchema, {
        hash: "h2",
        workflow: { name: "release", version: "4", own: true },
      }),
    ),
    deleteWorkflow: vi.fn(async () => ({})),
    exportWorkflow: vi.fn(async () => ({ zip: new Uint8Array([1]) })),
  };
  return calls;
}

function open(
  calls: ReturnType<typeof engine>,
  props: {
    canRun?: boolean;
    restored?: EditorDraft;
  } = {},
) {
  const handlers = {
    onDraft: vi.fn(),
    onChanged: vi.fn(),
    onCopied: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <ToastProvider>
      <WorkflowEditor
        client={calls as unknown as Client}
        name="release"
        canRun={props.canRun ?? true}
        isAdmin={false}
        me={ME}
        restored={props.restored}
        {...handlers}
      />
    </ToastProvider>,
  );
  return handlers;
}

const savedBodies = (calls: ReturnType<typeof engine>) =>
  calls.saveWorkflow.mock.calls.map(([draft, base]) => ({
    draft: draft as { name: string; files: Record<string, string> },
    base,
  }));

it("shows the workflow as stages on a canvas, with its version and the findings of the checks", async () => {
  const calls = engine({ findings: [finding()] });
  open(calls);
  expect(await screen.findByRole("heading", { name: "release" })).toBeVisible();
  expect(
    screen.getByText(
      "Version 3. Cards that are running keep the version they started with.",
    ),
  ).toBeVisible();
  const stages = within(screen.getByRole("list", { name: "Stages" }));
  expect(stages.getAllByRole("listitem")).toHaveLength(2);
  expect(
    stages.getByRole("button", { name: /^plan, Agent task/ }),
  ).toBeVisible();
  expect(
    stages.getByRole("button", { name: /^review, Approval/ }),
  ).toBeVisible();
  const findings = await screen.findByRole("region", { name: "Findings" });
  expect(
    await within(findings).findByText("route_target_unknown"),
  ).toBeVisible();
  expect(within(findings).getByText("1 error")).toBeVisible();
  // The finding marks the stage it is about.
  expect(
    screen.getByRole("button", { name: "plan, Agent task, has an error" }),
  ).toBeVisible();
  // Nothing is picked, so the panel is the workflow's.
  expect(
    screen.getByRole("complementary", { name: "Workflow settings" }),
  ).toBeVisible();
  expect(calls.getWorkflowDraft).toHaveBeenCalledWith(
    "release",
    expect.anything(),
  );
});

it("says the checks found no problems", async () => {
  open(engine());
  const findings = await screen.findByRole("region", { name: "Findings" });
  expect(
    await within(findings).findByText("The checks found no problems."),
  ).toBeVisible();
});

it("saves the edited prompt against the hash it was opened at, then has nothing left to save", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const handlers = open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  const panel = screen.getByRole("complementary", {
    name: "Settings of stage plan",
  });
  expect(within(panel).getByText("Stage 1 of 2")).toBeVisible();
  const save = screen.getByRole("button", { name: "Save version" });
  expect(save).toBeDisabled();
  const prompt = within(panel).getByRole("textbox", { name: "Prompt" });
  await user.clear(prompt);
  await user.type(prompt, "Plan it well.");
  expect(handlers.onDraft).toHaveBeenLastCalledWith(
    expect.objectContaining({ base: "h1" }),
  );
  await user.click(save);
  await waitFor(() => expect(handlers.onChanged).toHaveBeenCalled());
  const [first] = savedBodies(calls);
  const draft = first?.draft ?? { name: "", files: {} };
  const base = first?.base;
  expect(base).toBe("h1");
  expect(draft.name).toBe("release");
  expect(JSON.parse(draft.files["workflow.yaml"] ?? "").stages[0].prompt).toBe(
    "Plan it well.",
  );
  expect(handlers.onDraft).toHaveBeenLastCalledWith(undefined);
  expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
  // The save says which version it wrote.
  expect(await screen.findByText("Saved version 4")).toBeVisible();
});

it("does not say a save worked when the engine refused it", async () => {
  const user = userEvent.setup();
  const calls = engine();
  calls.saveWorkflow.mockRejectedValueOnce(
    new EngineError("permission_denied", "You cannot save this workflow.", 403),
  );
  open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  const panel = screen.getByRole("complementary", {
    name: "Settings of stage plan",
  });
  await user.type(within(panel).getByRole("textbox", { name: "Prompt" }), "!");
  await user.click(screen.getByRole("button", { name: "Save version" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "You cannot save this workflow.",
  );
  expect(screen.queryByText(/^Saved/)).toBeNull();
});

it("lets the starter prompt of a blank step be selected and replaced by typing", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const starter = "Describe the work this step does.\n\n# {{issue.title}}";
  calls.getWorkflowDraft.mockResolvedValueOnce(
    create(GetWorkflowDraftResponseSchema, {
      hash: "h1",
      textFiles: {
        ...files(),
        "workflow.yaml": JSON.stringify({
          version: 2,
          stages: [
            { id: "step", kind: "prompt", agent: "mine", prompt: starter },
          ],
        }),
      },
    }),
  );
  open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^step, Agent task/ }),
  );
  const prompt = within(
    screen.getByRole("complementary", { name: "Settings of stage step" }),
  ).getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
  expect(prompt).toHaveValue(starter);
  // Select the first sentence only, then type over it.
  prompt.focus();
  prompt.setSelectionRange(0, "Describe the work this step does.".length);
  await user.keyboard("Plan the work.");
  expect(prompt).toHaveValue("Plan the work.\n\n# {{issue.title}}");
  // Select everything and replace it.
  await user.keyboard("{Control>}a{/Control}Fresh text");
  expect(prompt).toHaveValue("Fresh text");
});

it("offers the agents a person may use, and puts the chosen one on the stage", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const handlers = open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  const panel = screen.getByRole("complementary", {
    name: "Settings of stage plan",
  });
  await user.click(within(panel).getByRole("combobox", { name: "Agent" }));
  // The list opens after the click, so wait for it. Only then is a missing option meaningful.
  expect(await screen.findByRole("option", { name: "mine" })).toBeVisible();
  // `theirs` belongs to someone else, so it is not offered.
  expect(screen.queryByRole("option", { name: "theirs" })).toBeNull();

  await user.click(screen.getByRole("option", { name: "other-mine" }));
  const kept = handlers.onDraft.mock.lastCall?.[0] as EditorDraft;
  expect(JSON.parse(kept.files["workflow.yaml"] ?? "").stages[0].agent).toBe(
    "other-mine",
  );
  await user.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => expect(calls.saveWorkflow).toHaveBeenCalledTimes(1));
  const [saved] = savedBodies(calls);
  expect(
    JSON.parse(saved?.draft.files["workflow.yaml"] ?? "").stages[0].agent,
  ).toBe("other-mine");
});

it("routes a result to another stage from the panel", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const handlers = open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^review, Approval/ }),
  );
  const panel = screen.getByRole("complementary", {
    name: "Settings of stage review",
  });
  await user.click(
    within(panel).getByRole("combobox", { name: "When it needs more work" }),
  );
  await user.click(await screen.findByRole("option", { name: "plan" }));
  const draft = handlers.onDraft.mock.calls.at(-1)?.[0] as EditorDraft;
  expect(JSON.parse(draft.files["workflow.yaml"] ?? "").stages[1].on).toEqual({
    needs_work: "plan",
  });
});

it("adds a stage of a kind or from a template and picks it", async () => {
  const user = userEvent.setup();
  const calls = engine();
  open(calls);
  await user.click(await screen.findByRole("button", { name: "Add stage" }));
  expect(await screen.findByText("From a template")).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Approval" }));
  expect(
    screen.getByRole("button", { name: /^approval, Approval/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Add stage" }));
  await user.click(await screen.findByRole("menuitem", { name: "Research" }));
  // The template's stock agent is replaced by one of the person's own.
  const panel = await screen.findByRole("complementary", {
    name: "Settings of stage research",
  });
  expect(
    within(panel).getByRole("combobox", { name: "Agent" }),
  ).toHaveTextContent("mine");
});

it("moves, copies and removes the picked stage", async () => {
  const user = userEvent.setup();
  open(engine());
  const names = () =>
    within(screen.getByRole("list", { name: "Stages" }))
      .getAllByRole("button", { name: /,/ })
      .map((button) => button.getAttribute("aria-label")?.split(",")[0]);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  await user.click(screen.getByRole("button", { name: "Move later" }));
  expect(names()).toEqual(["review", "plan"]);
  await user.click(screen.getByRole("button", { name: "Duplicate stage" }));
  expect(names()).toEqual(["review", "plan", "plan_copy"]);
  await user.click(screen.getByRole("button", { name: "Remove stage" }));
  expect(names()).toEqual(["review", "plan"]);
});

it("blocks a save made against an older version and reloads the current one", async () => {
  const user = userEvent.setup();
  const calls = engine();
  calls.saveWorkflow.mockRejectedValueOnce(
    new EngineError(
      "failed_precondition",
      "the workflow changed since you opened it; reload and try again",
      412,
    ),
  );
  const handlers = open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  const panel = screen.getByRole("complementary", {
    name: "Settings of stage plan",
  });
  await user.type(
    within(panel).getByRole("textbox", { name: "Prompt" }),
    " More.",
  );
  await user.click(screen.getByRole("button", { name: "Save version" }));
  const callout = await screen.findByRole("region", {
    name: "This workflow changed since you opened it",
  });
  expect(handlers.onChanged).not.toHaveBeenCalled();
  await user.click(within(callout).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(calls.getWorkflowDraft).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", {
        name: "This workflow changed since you opened it",
      }),
    ).toBeNull(),
  );
  expect(handlers.onDraft).toHaveBeenLastCalledWith(undefined);
});

it("shows what the engine refused a save for and runs the checks to say where", async () => {
  const user = userEvent.setup();
  const calls = engine();
  // The checks that run as the draft changes find nothing. Only the one a refused save runs,
  // which is made without a signal, finds the stage that is wrong.
  calls.checkDraft.mockImplementation(async (_draft, signal) =>
    create(CheckWorkflowResponseSchema, {
      packages: [
        {
          name: "release",
          path: "saved/release",
          findings: signal ? [] : [finding()],
        },
      ],
    }),
  );
  calls.saveWorkflow.mockRejectedValueOnce(
    new EngineError(
      "invalid_argument",
      "the workflow has errors: route_target_unknown",
      400,
    ),
  );
  open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  const panel = screen.getByRole("complementary", {
    name: "Settings of stage plan",
  });
  await user.type(within(panel).getByRole("textbox", { name: "Prompt" }), "!");
  // Let the checks that follow the typing finish first, so what shows next is the save's.
  await waitFor(() =>
    expect(
      calls.checkDraft.mock.calls.filter(([, signal]) => signal),
    ).not.toHaveLength(0),
  );
  await user.click(screen.getByRole("button", { name: "Save version" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "route_target_unknown",
  );
  // The stage the finding is about is marked, and the finding is listed.
  expect(
    await screen.findByRole("button", {
      name: "plan, Agent task, has an error",
    }),
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Findings" })).getByText(
      "route_target_unknown",
    ),
  ).toBeVisible();
  expect(
    calls.checkDraft.mock.calls.some(([, signal]) => signal === undefined),
  ).toBe(true);
});

it("asks before closing a draft with unsaved changes, and keeps it when told to", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const handlers = open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  const panel = screen.getByRole("complementary", {
    name: "Settings of stage plan",
  });
  await user.type(within(panel).getByRole("textbox", { name: "Prompt" }), "!");
  await user.click(screen.getByRole("button", { name: "Back to Workflows" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Discard your changes?")).toBeVisible();
  await user.click(
    within(dialog).getByRole("button", { name: "Keep editing" }),
  );
  expect(handlers.onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Back to Workflows" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Discard",
    }),
  );
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
  expect(handlers.onDraft).toHaveBeenLastCalledWith(undefined);
});

it("closes at once when nothing changed, and puts the text back on Discard changes", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const handlers = open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  const panel = screen.getByRole("complementary", {
    name: "Settings of stage plan",
  });
  const prompt = within(panel).getByRole("textbox", { name: "Prompt" });
  await user.type(prompt, "!");
  expect(prompt).toHaveValue("Plan it.!");
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Discard",
    }),
  );
  expect(handlers.onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /^plan, Agent task/ }));
  expect(
    within(
      screen.getByRole("complementary", { name: "Settings of stage plan" }),
    ).getByRole("textbox", { name: "Prompt" }),
  ).toHaveValue("Plan it.");
  await user.click(screen.getByRole("button", { name: "Back to Workflows" }));
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("returns to the text the page kept instead of reading the engine again", async () => {
  const calls = engine();
  const kept = {
    ...files(),
    "workflow.yaml": JSON.stringify({
      version: 2,
      stages: [{ id: "kept", kind: "prompt", agent: "mine", prompt: "x" }],
    }),
  };
  open(calls, { restored: { files: kept, original: files(), base: "h1" } });
  expect(
    await screen.findByRole("button", { name: /^kept, Agent task/ }),
  ).toBeVisible();
  expect(calls.getWorkflowDraft).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled();
});

it("saves a copy under a new name with only the stages, and hands it on", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const handlers = open(calls);
  await user.click(await screen.findByRole("button", { name: "Save as copy" }));
  const dialog = await screen.findByRole("dialog", { name: "Save as copy" });
  expect(
    within(dialog).getByText(
      "Make a new workflow from this draft. The original stays as it is.",
    ),
  ).toBeVisible();
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  expect(name).toHaveValue("release-copy");
  await user.clear(name);
  await user.type(name, "Bad Name");
  await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
  expect(
    await within(dialog).findByText(/Use lowercase letters/),
  ).toBeVisible();
  expect(calls.saveWorkflow).not.toHaveBeenCalled();
  await user.clear(name);
  await user.type(name, "release-two");
  await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
  await waitFor(() =>
    expect(handlers.onCopied).toHaveBeenCalledWith("release-two"),
  );
  const [first] = savedBodies(calls);
  const draft = first?.draft ?? { name: "", files: {} };
  const base = first?.base;
  expect(base).toBe("");
  expect(draft.name).toBe("release-two");
  expect(JSON.parse(draft.files["kiln-package.yaml"] ?? "").name).toBe(
    "release-two",
  );
});

it("shows why a copy could not be saved and stays open", async () => {
  const user = userEvent.setup();
  const calls = engine();
  calls.saveWorkflow.mockRejectedValueOnce(
    new EngineError(
      "already_exists",
      "a workflow named release-copy already exists",
      409,
    ),
  );
  const handlers = open(calls);
  await user.click(await screen.findByRole("button", { name: "Save as copy" }));
  const dialog = await screen.findByRole("dialog", { name: "Save as copy" });
  await user.click(within(dialog).getByRole("button", { name: "Save copy" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "already exists",
  );
  expect(handlers.onCopied).not.toHaveBeenCalled();
});

it("is read only for a built-in workflow: it can be copied but not saved or deleted", async () => {
  const user = userEvent.setup();
  open(engine({ own: false, builtin: true }));
  expect(
    await screen.findByText("Built in, version 3. Save as copy to change it."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save as copy" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "More actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Export as zip" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("menuitem", { name: "Delete workflow" }),
  ).toBeNull();
});

it("gives a reader the stages and the findings, and no way to change them", async () => {
  open(engine(), { canRun: false });
  expect(
    await screen.findByText("You can read this workflow, not change it."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save version" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add stage" })).toBeNull();
  expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  expect(
    screen.getByRole("button", { name: /^plan, Agent task/ }),
  ).toBeVisible();
});

it("asks before it deletes a workflow, then closes", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const handlers = open(calls);
  await user.click(await screen.findByRole("button", { name: "More actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Delete release?")).toBeVisible();
  expect(calls.deleteWorkflow).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", { name: "Delete workflow" }),
  );
  await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
  expect(calls.deleteWorkflow).toHaveBeenCalledWith("release");
  expect(handlers.onChanged).toHaveBeenCalled();
});

it("says so, with a way to try again, when the workflow cannot be read", async () => {
  const user = userEvent.setup();
  const calls = engine();
  calls.getWorkflowDraft.mockRejectedValueOnce(new Error("no such workflow"));
  open(calls);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no such workflow",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  ).toBeVisible();
});

it("saves again against the hash the first save returned, and is dirty only while there is something to save", async () => {
  const user = userEvent.setup();
  const calls = engine();
  calls.saveWorkflow
    .mockResolvedValueOnce(
      create(SaveWorkflowResponseSchema, {
        hash: "h2",
        workflow: { name: "release", version: "4", own: true },
      }),
    )
    .mockResolvedValueOnce(
      create(SaveWorkflowResponseSchema, {
        hash: "h3",
        workflow: { name: "release", version: "5", own: true },
      }),
    );
  const handlers = open(calls);
  await user.click(
    await screen.findByRole("button", { name: /^plan, Agent task/ }),
  );
  const prompt = () =>
    within(
      screen.getByRole("complementary", { name: "Settings of stage plan" }),
    ).getByRole("textbox", { name: "Prompt" });
  const save = screen.getByRole("button", { name: "Save version" });
  expect(save).toBeDisabled();

  await user.type(prompt(), " one");
  expect(save).toBeEnabled();
  await user.click(save);
  await waitFor(() => expect(calls.saveWorkflow).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(save).toBeDisabled());
  expect(await screen.findByText("Saved version 4")).toBeVisible();

  await user.type(prompt(), " two");
  expect(save).toBeEnabled();
  await user.click(save);
  await waitFor(() => expect(calls.saveWorkflow).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(save).toBeDisabled());
  expect(await screen.findByText("Saved version 5")).toBeVisible();

  expect(savedBodies(calls).map(({ base }) => base)).toEqual(["h1", "h2"]);
  const second = savedBodies(calls)[1]?.draft.files["workflow.yaml"] ?? "";
  expect(JSON.parse(second).stages[0].prompt).toBe("Plan it. one two");
  expect(handlers.onChanged).toHaveBeenCalledTimes(2);
});

it("says the stages could not be read for a workflow.yaml that is not a workflow", async () => {
  const calls = engine();
  calls.getWorkflowDraft.mockResolvedValueOnce(
    create(GetWorkflowDraftResponseSchema, {
      hash: "h1",
      textFiles: { ...files(), "workflow.yaml": "{ not a workflow" },
    }),
  );
  open(calls);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This workflow's stages could not be read, so it cannot be edited here.",
  );
  expect(screen.queryByRole("list", { name: "Stages" })).toBeNull();
});

it("says so when a template cannot be read, and adds nothing", async () => {
  const user = userEvent.setup();
  const calls = engine();
  calls.listStageTemplates.mockResolvedValue(
    create(ListStageTemplatesResponseSchema, {
      templates: [{ id: "broken", stageJson: "{ nope" }],
    }),
  );
  const handlers = open(calls);
  await user.click(await screen.findByRole("button", { name: "Add stage" }));
  await user.click(await screen.findByRole("menuitem", { name: "broken" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That template could not be read.",
  );
  expect(handlers.onDraft).not.toHaveBeenCalled();
  expect(
    within(screen.getByRole("list", { name: "Stages" })).getAllByRole(
      "listitem",
    ),
  ).toHaveLength(2);
});

it("lists the kinds of stage by the words the canvas uses", async () => {
  const user = userEvent.setup();
  open(engine());
  await user.click(await screen.findByRole("button", { name: "Add stage" }));
  for (const label of ["Agent task", "Approval", "Wait", "Automatic job"])
    expect(await screen.findByRole("menuitem", { name: label })).toBeVisible();
});

/** Runs what the clock would run, so a check that waits for a quiet moment can be observed. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("checks the draft once, a moment after the last change, and not on every edit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const calls = engine();
    open(calls);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^plan, Agent task/ }));
    const prompt = () =>
      within(
        screen.getByRole("complementary", { name: "Settings of stage plan" }),
      ).getByRole("textbox", { name: "Prompt" });
    // The draft as it opened has not been checked before the delay is over.
    await settle(399);
    expect(calls.checkDraft).not.toHaveBeenCalled();

    // A change restarts the wait, so the opening check never runs.
    fireEvent.change(prompt(), { target: { value: "One" } });
    await settle(399);
    expect(calls.checkDraft).not.toHaveBeenCalled();
    fireEvent.change(prompt(), { target: { value: "Two" } });
    await settle(399);
    expect(calls.checkDraft).not.toHaveBeenCalled();
    await settle(1);
    expect(calls.checkDraft).toHaveBeenCalledTimes(1);
    const checked = calls.checkDraft.mock.calls[0]?.[0] as {
      files: Record<string, string>;
    };
    expect(
      JSON.parse(checked.files["workflow.yaml"] ?? "").stages[0].prompt,
    ).toBe("Two");
    // Nothing more is pending.
    await settle(5_000);
    expect(calls.checkDraft).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("says the checks could not run, and drops the findings of the draft before", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const calls = engine({ findings: [finding()] });
    open(calls);
    // The workflow is read first, and the draft is checked a moment after that.
    await settle();
    await settle(400);
    await settle();
    expect(
      screen.getByRole("button", { name: "plan, Agent task, has an error" }),
    ).toBeVisible();
    expect(screen.queryByText("Checks could not run")).toBeNull();

    calls.checkDraft.mockRejectedValue(new Error("Beehive is down"));
    fireEvent.click(screen.getByRole("button", { name: /^plan, Agent task/ }));
    fireEvent.change(
      within(
        screen.getByRole("complementary", { name: "Settings of stage plan" }),
      ).getByRole("textbox", { name: "Prompt" }),
      { target: { value: "Changed" } },
    );
    await settle(400);
    await settle();
    expect(screen.getByText("Checks could not run")).toBeVisible();
    // The old finding is not shown as if it described the new draft.
    expect(screen.queryByRole("button", { name: /has an error/ })).toBeNull();
    expect(screen.queryByText("route_target_unknown")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the address of an exported file alive until the browser has read it", async () => {
  const created = vi.fn(() => "blob:release");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoke }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    const user = userEvent.setup();
    const calls = engine();
    open(calls);
    await user.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    const item = await screen.findByRole("menuitem", { name: "Export as zip" });
    // The clock is the subject only from here: the file is handed over and the wait begins.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(item);
    await settle();
    expect(calls.exportWorkflow).toHaveBeenCalledWith("release");
    expect(click).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledTimes(1);
    // Revoking at once would cancel the download in a browser that reads the file later.
    expect(revoke).not.toHaveBeenCalled();
    await settle(999);
    expect(revoke).not.toHaveBeenCalled();
    await settle(1);
    expect(revoke).toHaveBeenCalledWith("blob:release");
  } finally {
    click.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
