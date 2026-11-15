// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { Client } from "./engine/client";
import {
  IntakeRuleSchema,
  ListIntakeRulesResponseSchema,
  ListReposResponseSchema,
  RefreshIntakeResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";
import { IntakePage, parseLogins, ruleSummary } from "./IntakePage";

afterEach(cleanup);

const rule = (fields: Record<string, unknown> = {}) =>
  create(IntakeRuleSchema, {
    id: "r1",
    name: "Bugs",
    enabled: true,
    workflow: "rpi",
    intake: {
      host: "github.com",
      repos: ["example-org/api"],
      label: "bug",
      assignees: "anyone",
      authors: ["octo"],
      intervalS: 900,
    },
    ...fields,
  });

function engine(rules: ReturnType<typeof rule>[] = [rule()]) {
  const client = {
    listIntakeRules: vi.fn(async () =>
      create(ListIntakeRulesResponseSchema, { rules }),
    ),
    saveIntakeRule: vi.fn(async (saved: unknown) =>
      create(IntakeRuleSchema, saved as never),
    ),
    deleteIntakeRule: vi.fn(async () => ({})),
    refreshIntake: vi.fn(async () =>
      create(RefreshIntakeResponseSchema, { addedCardIds: ["a", "b"] }),
    ),
    listRepos: vi.fn(async () =>
      create(ListReposResponseSchema, {
        repos: ["example-org/api", "example-org/web"],
      }),
    ),
  };
  return { client: client as unknown as Client, calls: client };
}

it("lists each rule with its repo, label, authors, how often it reads and where its cards go", async () => {
  render(<IntakePage client={engine().client} canRun />);
  const list = await screen.findByRole("list", { name: "Intake rules" });
  const [row] = within(list).getAllByRole("listitem");
  expect(row).toHaveTextContent("Bugs");
  expect(row).toHaveTextContent("example-org/api, label bug, opened by octo");
  expect(row).toHaveTextContent("Every 15 minutes");
  expect(row).toHaveTextContent("workflow rpi");
});

it("shows the rules to a reader but offers no change", async () => {
  render(<IntakePage client={engine().client} canRun={false} />);
  await screen.findByRole("list", { name: "Intake rules" });
  for (const name of ["New rule", "Refresh all", "Refresh", "Edit", "Delete"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});

it("explains an empty list and offers the first rule to someone who can run", async () => {
  render(<IntakePage client={engine([]).client} canRun />);
  expect(await screen.findByText("No intake rules")).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: "New rule" }).length,
  ).toBeGreaterThan(0);
});

it("saves a new rule with one repo, the label and the logins as typed", async () => {
  const user = userEvent.setup();
  const e = engine([]);
  render(<IntakePage client={e.client} canRun />);
  await screen.findByText("No intake rules");
  await user.click(
    screen.getAllByRole("button", { name: "New rule" }).at(0) as HTMLElement,
  );
  const dialog = await screen.findByRole("dialog", { name: "New rule" });
  await user.click(
    await within(dialog).findByRole("combobox", { name: "Repo" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "example-org/api" }),
  );
  await user.type(within(dialog).getByLabelText(/^Label/), "bug");
  await user.type(within(dialog).getByLabelText(/^Authors/), "@octo, hubot");
  await user.click(within(dialog).getByRole("button", { name: "Save rule" }));
  expect(e.calls.saveIntakeRule).toHaveBeenCalledTimes(1);
  expect(e.calls.saveIntakeRule.mock.calls[0]?.[0]).toMatchObject({
    id: "",
    enabled: true,
    intake: {
      host: "github.com",
      repos: ["example-org/api"],
      label: "bug",
      assignees: "anyone",
      authors: ["octo", "hubot"],
      intervalS: 900,
    },
  });
  // The list is read again after a save.
  expect(e.calls.listIntakeRules.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("will not save a rule with no repo", async () => {
  const user = userEvent.setup();
  const e = engine([]);
  render(<IntakePage client={e.client} canRun />);
  await screen.findByText("No intake rules");
  await user.click(
    screen.getAllByRole("button", { name: "New rule" }).at(0) as HTMLElement,
  );
  const dialog = await screen.findByRole("dialog", { name: "New rule" });
  await user.click(within(dialog).getByRole("button", { name: "Save rule" }));
  expect(await within(dialog).findByText("Choose a repo.")).toBeVisible();
  expect(e.calls.saveIntakeRule).not.toHaveBeenCalled();
});

it("shows the engine's reason when it refuses a rule, and keeps the form", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.saveIntakeRule.mockRejectedValueOnce(
    new Error("interval_s must be at least 60"),
  );
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit rule" });
  await user.click(within(dialog).getByRole("button", { name: "Save rule" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "interval_s must be at least 60",
  );
  expect(screen.getByRole("dialog", { name: "Edit rule" })).toBeVisible();
});

it("switches a rule off with the rest of the rule kept", async () => {
  const user = userEvent.setup();
  const e = engine();
  render(<IntakePage client={e.client} canRun />);
  await user.click(
    await screen.findByRole("switch", { name: /Rule on: Bugs/ }),
  );
  expect(e.calls.saveIntakeRule.mock.calls[0]?.[0]).toMatchObject({
    id: "r1",
    enabled: false,
    name: "Bugs",
    intake: { repos: ["example-org/api"], label: "bug" },
  });
});

it("asks before deleting a rule and says its cards stay", async () => {
  const user = userEvent.setup();
  const e = engine();
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("alertdialog");
  expect(confirm).toHaveTextContent("Cards it already made stay on the board.");
  expect(e.calls.deleteIntakeRule).not.toHaveBeenCalled();
  await user.click(
    within(confirm).getByRole("button", { name: "Delete rule" }),
  );
  expect(e.calls.deleteIntakeRule).toHaveBeenCalledWith("r1");
});

it("refreshes one rule and says how many cards it added", async () => {
  const user = userEvent.setup();
  const e = engine();
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Refresh" }));
  expect(e.calls.refreshIntake).toHaveBeenCalledWith("r1");
  expect(await screen.findByText("Added 2 cards.")).toBeVisible();
});

it("says a refresh the host limited in the engine's words", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.refreshIntake.mockRejectedValueOnce(
    new Error("GitHub rate limit: try again in 5 minutes"),
  );
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Refresh all" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "GitHub rate limit: try again in 5 minutes",
  );
});

it("reads the rules again after a failure", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.listIntakeRules.mockRejectedValueOnce(new Error("offline"));
  render(<IntakePage client={e.client} canRun />);
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("list", { name: "Intake rules" }),
  ).toBeVisible();
});

it("reads logins separated by commas or spaces and drops a leading @", () => {
  expect(parseLogins("@octo, hubot  mallory,")).toEqual([
    "octo",
    "hubot",
    "mallory",
  ]);
  expect(parseLogins("")).toEqual([]);
});

it("summarises a rule that has no label or authors by its repo", () => {
  expect(
    ruleSummary(
      rule({
        intake: {
          host: "github.com",
          repos: ["example-org/api"],
          assignees: "unassigned",
        },
      }),
    ),
  ).toBe("example-org/api, unassigned");
});
