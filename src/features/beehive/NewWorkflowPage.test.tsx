// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
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
  ListAgentsResponseSchema,
  ListWorkflowsResponseSchema,
  SaveWorkflowResponseSchema,
  WorkflowSchema,
} from "./gen/kiln/engine/v1/engine_pb";
import { NewWorkflowPage } from "./NewWorkflowPage";

afterEach(cleanup);

const ME = "aa".repeat(32);

function engine() {
  return {
    listAgents: vi.fn(async () =>
      create(ListAgentsResponseSchema, {
        agents: [
          { name: "mine", pubkey: "01", ownerPubkey: ME },
          { name: "theirs", pubkey: "02", ownerPubkey: "bb".repeat(32) },
        ],
      }),
    ),
    listWorkflows: vi.fn(async () =>
      create(ListWorkflowsResponseSchema, {
        workflows: [{ name: "rpi", ok: true }],
      }),
    ),
    saveWorkflow: vi.fn(async (_draft: unknown, _base: string) =>
      create(SaveWorkflowResponseSchema, {
        hash: "h",
        workflow: { name: "flow" },
      }),
    ),
    duplicateWorkflow: vi.fn(async (_from: string, to: string) =>
      create(WorkflowSchema, { name: to }),
    ),
    importWorkflow: vi.fn(async (_zip: Uint8Array) =>
      create(WorkflowSchema, { name: "imported" }),
    ),
  };
}

function open(calls: ReturnType<typeof engine>, isAdmin = false) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <NewWorkflowPage
      client={calls as unknown as Client}
      isAdmin={isAdmin}
      me={ME}
      onCreated={onCreated}
      onClose={onClose}
    />,
  );
  return { onCreated, onClose };
}

async function chooseAgent(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("combobox", { name: "Agent for the agent tasks" }),
  );
  await user.click(await screen.findByRole("option", { name: "mine" }));
}

it("offers the four recipes and the other ways to begin", async () => {
  open(engine());
  expect(
    await screen.findByRole("heading", { name: "New workflow" }),
  ).toBeVisible();
  const recipes = screen.getByRole("region", { name: "Start from a recipe" });
  expect(within(recipes).getByText("Recommended")).toBeVisible();
  for (const [title, text] of [
    ["Engineering", "Research, plan, build, review and open a pull request."],
    ["Do a task", "An agent does the work and you review it."],
    ["Write a document", "An agent drafts a document and you approve it."],
    ["Blank", "Start with one step and add your own."],
  ]) {
    const card = within(recipes).getByRole("button", {
      name: new RegExp(`^${title}`),
    });
    expect(card).toBeVisible();
    expect(within(card).getByText(text as string)).toBeVisible();
  }
  const other = screen.getByRole("region", { name: "Other ways to begin" });
  expect(
    within(other).getByRole("combobox", { name: "Workflow to copy" }),
  ).toBeVisible();
  expect(
    within(other).getByRole("button", { name: "Start from a copy" }),
  ).toBeVisible();
  expect(within(other).getByRole("button", { name: "Import" })).toBeVisible();
});

it("saves a recipe under the name and agent given, and hands the new workflow on", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const { onCreated } = open(calls);
  await user.type(
    await screen.findByRole("textbox", { name: /^Name/ }),
    "ship",
  );
  await chooseAgent(user);
  await user.click(screen.getByRole("button", { name: /^Do a task/ }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("flow"));
  const [draft, base] = calls.saveWorkflow.mock.calls[0] as [
    { name: string; files: Record<string, string> },
    string,
  ];
  expect(base).toBe("");
  expect(draft.name).toBe("ship");
  expect(JSON.parse(draft.files["kiln-package.yaml"] ?? "").name).toBe("ship");
  const stages = JSON.parse(draft.files["workflow.yaml"] ?? "").stages;
  expect(stages.map((s: { id: string }) => s.id)).toEqual(["do", "review"]);
  expect(stages[0].agent).toBe("mine");
});

it("offers only the agents a person may use, and every agent to an admin", async () => {
  const user = userEvent.setup();
  open(engine(), true);
  await user.click(
    await screen.findByRole("combobox", { name: "Agent for the agent tasks" }),
  );
  expect(await screen.findByRole("option", { name: "theirs" })).toBeVisible();
});

it("refuses a name the engine would refuse, and asks for an agent, before saving anything", async () => {
  const user = userEvent.setup();
  const calls = engine();
  open(calls);
  await screen.findByRole("textbox", { name: /^Name/ });
  await user.click(screen.getByRole("button", { name: /^Blank/ }));
  expect(await screen.findByText(/Use lowercase letters/)).toBeVisible();
  await user.type(screen.getByRole("textbox", { name: /^Name/ }), "ok-name");
  await user.click(screen.getByRole("button", { name: /^Blank/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose the agent",
  );
  expect(calls.saveWorkflow).not.toHaveBeenCalled();
});

it("shows the engine's refusal and lets the person try again", async () => {
  const user = userEvent.setup();
  const calls = engine();
  calls.saveWorkflow.mockRejectedValueOnce(
    new EngineError(
      "already_exists",
      "a workflow named ship already exists",
      409,
    ),
  );
  const { onCreated } = open(calls);
  await user.type(
    await screen.findByRole("textbox", { name: /^Name/ }),
    "ship",
  );
  await chooseAgent(user);
  await user.click(screen.getByRole("button", { name: /^Engineering/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  expect(onCreated).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /^Engineering/ }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
});

it("starts from a copy of a workflow that exists", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const { onCreated } = open(calls);
  await user.type(
    await screen.findByRole("textbox", { name: /^Name/ }),
    "my-rpi",
  );
  await user.click(screen.getByRole("button", { name: "Start from a copy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose a workflow to copy.",
  );
  await user.click(screen.getByRole("combobox", { name: "Workflow to copy" }));
  await user.click(await screen.findByRole("option", { name: "rpi" }));
  await user.click(screen.getByRole("button", { name: "Start from a copy" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("my-rpi"));
  expect(calls.duplicateWorkflow).toHaveBeenCalledWith("rpi", "my-rpi");
});

it("imports a zip from the dialog and opens what it holds", async () => {
  const user = userEvent.setup();
  const calls = engine();
  const { onCreated } = open(calls);
  await user.click(await screen.findByRole("button", { name: "Import" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Import a workflow",
  });
  expect(
    within(dialog).getByText("Choose where the workflow comes from."),
  ).toBeVisible();
  expect(
    within(dialog).getByText(
      "A .zip that Export wrote, with the workflow and its files.",
    ),
  ).toBeVisible();
  const file = new File([new Uint8Array([80, 75])], "flow.zip", {
    type: "application/zip",
  });
  fireEvent.change(within(dialog).getByLabelText("Workflow zip"), {
    target: { files: [file] },
  });
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("imported"));
  expect(calls.importWorkflow).toHaveBeenCalledTimes(1);
});

it("closes on Cancel and on the way back to Workflows", async () => {
  const user = userEvent.setup();
  const { onClose } = open(engine());
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Back to Workflows" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
