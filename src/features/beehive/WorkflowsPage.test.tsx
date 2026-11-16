// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Client } from "./engine/client";
import {
  CheckWorkflowResponseSchema,
  ListWorkflowsResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";
import { WorkflowsPage, stageSummary } from "./WorkflowsPage";

afterEach(cleanup);

type Listed = MessageInitShape<typeof ListWorkflowsResponseSchema>;
type Checked = MessageInitShape<typeof CheckWorkflowResponseSchema>;

function engine(
  workflows: NonNullable<Listed["workflows"]>,
  packages: NonNullable<Checked["packages"]>,
) {
  const client = {
    listWorkflows: vi.fn(async () =>
      create(ListWorkflowsResponseSchema, { workflows }),
    ),
    checkWorkflow: vi.fn(async () =>
      create(CheckWorkflowResponseSchema, { packages }),
    ),
  };
  return { client: client as unknown as Client, calls: client };
}

const demo = {
  name: "demo",
  version: "0.1.0",
  description: "A small workflow.",
  builtin: true,
  ok: true,
  stages: [
    { id: "plan", name: "Plan", kind: "prompt", agent: "builder" },
    { id: "approve", kind: "approval", pause: true },
  ],
};

it("lists each package with its stages, the kind of each and the agent a prompt runs on", async () => {
  render(
    <WorkflowsPage
      client={
        engine([demo], [{ name: "demo", path: "builtin/demo", findings: [] }])
          .client
      }
    />,
  );
  const section = await screen.findByRole("region", { name: "demo" });
  expect(within(section).getByText("A small workflow.")).toBeVisible();
  expect(within(section).getByText("Ready")).toBeVisible();
  expect(within(section).getByText("Built in, version 0.1.0")).toBeVisible();
  const stages = within(section).getAllByRole("listitem");
  expect(stages).toHaveLength(2);
  expect(stages[0]).toHaveTextContent("Plan");
  expect(stages[0]).toHaveTextContent("Prompt, agent builder");
  // A stage with no name shows its id.
  expect(stages[1]).toHaveTextContent("approve");
  expect(stages[1]).toHaveTextContent(
    "Approval, waits for a person to start it",
  );
  expect(within(section).queryByRole("list", { name: /Findings/ })).toBeNull();
});

it("says an approval waits for a person, and gives a package that is not built in its version", async () => {
  render(
    <WorkflowsPage
      client={
        engine(
          [
            {
              name: "mine",
              version: "1",
              ok: true,
              stages: [
                { id: "gate", name: "plan_review", kind: "approval" },
                {
                  id: "build",
                  name: "implement",
                  kind: "prompt",
                  agent: "builder",
                },
              ],
            },
          ],
          [{ name: "mine", path: "workflows/mine", findings: [] }],
        ).client
      }
    />,
  );
  const section = await screen.findByRole("region", { name: "mine" });
  expect(within(section).getByText("Version 1")).toBeVisible();
  const stages = within(section).getAllByRole("listitem");
  expect(stages[0]).toHaveTextContent("Approval, waits for a person");
  expect(stages[0]).not.toHaveTextContent("to start it");
  expect(stages[1]).toHaveTextContent("Prompt, agent builder");
});

it("shows each finding with its severity, code and message beside its package", async () => {
  render(
    <WorkflowsPage
      client={
        engine(
          [{ name: "broken", ok: false, stages: [] }],
          [
            {
              name: "broken",
              path: "workflows/broken",
              findings: [
                {
                  path: "workflow.yaml:stages[0].on.passed",
                  code: "route_target_unknown",
                  severity: "error",
                  message: "no such stage",
                },
                {
                  code: "route_cycle_unbounded",
                  severity: "warning",
                  message: "a loop has no limit",
                },
              ],
            },
          ],
        ).client
      }
    />,
  );
  const section = await screen.findByRole("region", { name: "broken" });
  expect(within(section).getByText("Has problems")).toBeVisible();
  const findings = within(
    within(section).getByRole("list", { name: "Findings for broken" }),
  ).getAllByRole("listitem");
  expect(findings).toHaveLength(2);
  expect(findings[0]).toHaveTextContent(
    "Error route_target_unknown no such stage",
  );
  expect(findings[0]).toHaveTextContent("workflow.yaml:stages[0].on.passed");
  expect(findings[1]).toHaveTextContent("Warning route_cycle_unbounded");
});

it("lists a folder that did not load by its path, apart from the packages", async () => {
  render(
    <WorkflowsPage
      client={
        engine(
          [demo],
          [
            { name: "demo", path: "builtin/demo", findings: [] },
            {
              name: "",
              path: "workflows/nameless",
              findings: [
                {
                  code: "package_unreadable",
                  severity: "error",
                  message: "kiln-package.yaml has no name",
                },
              ],
            },
          ],
        ).client
      }
    />,
  );
  const section = await screen.findByRole("region", {
    name: "Packages that did not load",
  });
  expect(within(section).getByText("workflows/nameless")).toBeVisible();
  expect(within(section).getByText("Not loaded")).toBeVisible();
  expect(
    within(section).getByRole("list", {
      name: "Findings for workflows/nameless",
    }),
  ).toHaveTextContent("package_unreadable");
});

it("says so when no workflow is loaded", async () => {
  render(<WorkflowsPage client={engine([], []).client} />);
  expect(await screen.findByText("No workflows")).toBeVisible();
});

it("shows the failure and reads again on Retry, without claiming there are no workflows", async () => {
  const e = engine(
    [demo],
    [{ name: "demo", path: "builtin/demo", findings: [] }],
  );
  e.calls.listWorkflows.mockRejectedValueOnce(
    new Error("Beehive is not reachable"),
  );
  render(<WorkflowsPage client={e.client} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  expect(screen.queryByText("No workflows")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("region", { name: "demo" })).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("names a kind it does not know as the engine sent it", () => {
  expect(
    stageSummary({
      id: "x",
      name: "",
      kind: "review",
      agent: "",
      pause: false,
    } as never),
  ).toBe("review");
});

it("tags a built-in workflow and opens a workflow in the editor from its Edit button", async () => {
  const onEdit = vi.fn();
  render(
    <WorkflowsPage
      canRun
      onEdit={onEdit}
      client={
        engine([demo], [{ name: "demo", path: "builtin/demo", findings: [] }])
          .client
      }
    />,
  );
  const section = await screen.findByRole("region", { name: "demo" });
  expect(within(section).getByText("Built in")).toBeVisible();
  await userEvent.click(
    within(section).getByRole("button", { name: "Edit demo" }),
  );
  expect(onEdit).toHaveBeenCalledWith("demo");
});

it("offers a person who cannot run View in the place of Edit", async () => {
  render(
    <WorkflowsPage
      onEdit={vi.fn()}
      client={
        engine([demo], [{ name: "demo", path: "builtin/demo", findings: [] }])
          .client
      }
    />,
  );
  expect(
    await screen.findByRole("button", { name: "View demo" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Edit demo" })).toBeNull();
});

it("reads the workflows again when a workflow was saved", async () => {
  const e = engine([demo], []);
  const { rerender } = render(<WorkflowsPage client={e.client} revision={0} />);
  await screen.findByRole("region", { name: "demo" });
  expect(e.calls.listWorkflows).toHaveBeenCalledTimes(1);
  rerender(<WorkflowsPage client={e.client} revision={1} />);
  await vi.waitFor(() =>
    expect(e.calls.listWorkflows).toHaveBeenCalledTimes(2),
  );
});

it("keeps the list and says the checks could not run when only the checks fail", async () => {
  const e = engine([demo], []);
  e.calls.checkWorkflow.mockRejectedValueOnce(new Error("Beehive is down"));
  render(<WorkflowsPage client={e.client} />);
  const section = await screen.findByRole("region", { name: "demo" });
  expect(within(section).getByText("A small workflow.")).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Checks could not run. Beehive is down",
  );
});

it("still fails the page when the workflows themselves cannot be read", async () => {
  const e = engine([demo], []);
  e.calls.listWorkflows.mockRejectedValueOnce(new Error("no workflows"));
  render(<WorkflowsPage client={e.client} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("no workflows");
  expect(screen.queryByRole("region", { name: "demo" })).toBeNull();
});
