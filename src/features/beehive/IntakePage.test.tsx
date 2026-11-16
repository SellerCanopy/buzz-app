// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { Client } from "./engine/client";
import {
  IntakeRuleSchema,
  ListIntakeRulesResponseSchema,
  ListReposResponseSchema,
  PreviewIntakeResponseSchema,
  RefreshIntakeResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";
import {
  ASSIGNEES,
  matchCount,
  DEFAULT_INTERVAL_S,
  effectiveInterval,
  IntakePage,
  INTERVALS,
  intervalLabel,
  MIN_INTERVAL_S,
  parseLogins,
  ruleSummary,
} from "./IntakePage";

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
    previewIntake: vi.fn(async (_rule: unknown, _signal?: AbortSignal) =>
      create(PreviewIntakeResponseSchema, {
        issues: [
          { ref: { owner: "example-org", repo: "api", number: 7 }, title: "A" },
          { ref: { owner: "example-org", repo: "api", number: 9 }, title: "B" },
        ],
      }),
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
  expect(row).toHaveTextContent("Sends issues to rpi");
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

it("counts the issues that match a count as the person words it", () => {
  expect(matchCount(0, false)).toBe("No issues match");
  expect(matchCount(1, false)).toBe("1 issue matches");
  expect(matchCount(3, false)).toBe("3 issues match");
  expect(matchCount(30, true)).toBe("At least 30 issues match");
});

it("names the issues a rule would take once the person stops typing, and asks nothing before a repo is chosen", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const e = engine([]);
    render(<IntakePage client={e.client} canRun />);
    await screen.findByText("No intake rules");
    await user.click(
      screen.getAllByRole("button", { name: "New rule" }).at(0) as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "New rule" });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(e.calls.previewIntake).not.toHaveBeenCalled();
    await user.click(
      await within(dialog).findByRole("combobox", { name: "Repo" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "example-org/api" }),
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Checking which issues match",
    );
    // Typing a label restarts the wait, so one read follows the last change.
    await user.type(within(dialog).getByLabelText(/^Label/), "bug");
    expect(e.calls.previewIntake).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(e.calls.previewIntake).toHaveBeenCalledTimes(1);
    expect(e.calls.previewIntake.mock.calls[0]?.[0]).toMatchObject({
      host: "github.com",
      repos: ["example-org/api"],
      label: "bug",
    });
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "2 issues match example-org/api#7, example-org/api#9",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("says the preview could not be read and still lets the rule be saved", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const e = engine([rule()]);
    e.calls.previewIntake.mockRejectedValueOnce(new Error("no GitHub token"));
    render(<IntakePage client={e.client} canRun />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit rule" });
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Could not check which issues match. no GitHub token",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save rule" }));
    expect(e.calls.saveIntakeRule).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
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
  // The failure of the first read does not outlive the read that worked.
  expect(screen.queryByRole("alert")).toBeNull();
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

const openEdit = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.findByRole("dialog", { name: "Edit rule" });
};

const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  field: string,
  option: string,
) => {
  await user.click(
    await within(dialog).findByRole("combobox", { name: field }),
  );
  await user.click(await screen.findByRole("option", { name: option }));
};

it("says Nothing new when a refresh added no card, and Added 1 card for one", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.refreshIntake.mockResolvedValueOnce(
    create(RefreshIntakeResponseSchema, { addedCardIds: [] }),
  );
  e.calls.refreshIntake.mockResolvedValueOnce(
    create(RefreshIntakeResponseSchema, { addedCardIds: ["a"] }),
  );
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Refresh all" }));
  expect(e.calls.refreshIntake).toHaveBeenLastCalledWith("");
  expect(await screen.findByText("Nothing new.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh all" }));
  expect(await screen.findByText("Added 1 card.")).toBeVisible();
});

it("ignores a second action while one is running", async () => {
  const user = userEvent.setup();
  const e = engine();
  let release: () => void = () => {};
  e.calls.refreshIntake.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve(create(RefreshIntakeResponseSchema, { addedCardIds: [] }));
      }),
  );
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Refresh all" }));
  await vi.waitFor(() => expect(e.calls.refreshIntake).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Refresh all" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  try {
    await user.click(screen.getByRole("button", { name: "Refresh all" }));
    expect(e.calls.refreshIntake).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  expect(await screen.findByText("Nothing new.")).toBeVisible();
});

it("says a failed switch beside the rules, which stay on screen", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.saveIntakeRule.mockRejectedValueOnce(new Error("could not save"));
  render(<IntakePage client={e.client} canRun />);
  await user.click(
    await screen.findByRole("switch", { name: /Rule on: Bugs/ }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("could not save");
  expect(screen.getByRole("list", { name: "Intake rules" })).toBeVisible();
});

it("keeps the rules and says so when reading them again fails after a change", async () => {
  const user = userEvent.setup();
  const e = engine();
  render(<IntakePage client={e.client} canRun />);
  const toggle = await screen.findByRole("switch", { name: /Rule on: Bugs/ });
  e.calls.listIntakeRules.mockRejectedValueOnce(new Error("offline"));
  await user.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  expect(screen.getByRole("list", { name: "Intake rules" })).toBeVisible();
});

it("deletes after the confirmation, closes it and reads the rules again", async () => {
  const user = userEvent.setup();
  const e = engine();
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("alertdialog");
  const reads = e.calls.listIntakeRules.mock.calls.length;
  await user.click(
    within(confirm).getByRole("button", { name: "Delete rule" }),
  );
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await vi.waitFor(() =>
    expect(e.calls.listIntakeRules.mock.calls.length).toBeGreaterThan(reads),
  );
});

it("leaves the rule alone when the delete confirmation is cancelled", async () => {
  const user = userEvent.setup();
  const e = engine();
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("alertdialog");
  await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(e.calls.deleteIntakeRule).not.toHaveBeenCalled();
  expect(screen.getByRole("list", { name: "Intake rules" })).toBeVisible();
});

it("says a failed delete inside the confirmation, which stays open", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.deleteIntakeRule.mockRejectedValueOnce(new Error("rule is busy"));
  render(<IntakePage client={e.client} canRun />);
  await user.click(await screen.findByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("alertdialog");
  await user.click(
    within(confirm).getByRole("button", { name: "Delete rule" }),
  );
  expect(await within(confirm).findByRole("alert")).toHaveTextContent(
    "rule is busy",
  );
  expect(screen.getByRole("alertdialog")).toBeVisible();
});

it("labels a rule with no name by its search, and shows an off rule as Off with no Refresh", async () => {
  render(
    <IntakePage
      client={
        engine([rule({ name: "", enabled: false }), rule({ id: "r2" })]).client
      }
      canRun
    />,
  );
  const list = await screen.findByRole("list", { name: "Intake rules" });
  const [off] = within(list).getAllByRole("listitem");
  expect(off).toHaveTextContent("example-org/api, label bug, opened by octo");
  expect(off).toHaveTextContent("Turned off");
  expect(
    within(off as HTMLElement).getByRole("button", { name: "Refresh" }),
  ).toBeDisabled();
  expect(
    within(off as HTMLElement).getByRole("switch", {
      name: "Rule on: example-org/api, label bug, opened by octo",
    }),
  ).not.toBeChecked();
});

it("names an interval the list does not know in seconds, and reads 0 as the engine's default", () => {
  expect(intervalLabel(45)).toBe("Every 45 seconds");
  expect(intervalLabel(0)).toBe("Every 15 minutes");
  expect(effectiveInterval(0)).toBe(DEFAULT_INTERVAL_S);
  expect(effectiveInterval(120)).toBe(120);
  // The ladder starts at the engine's least and offers its default.
  expect(INTERVALS[0]?.seconds).toBe(MIN_INTERVAL_S);
  expect(INTERVALS.map((i) => i.seconds)).toContain(DEFAULT_INTERVAL_S);
});

it("shows a rule with no interval as reading every 15 minutes", async () => {
  const stored = rule({
    intake: { host: "github.com", repos: ["example-org/api"], intervalS: 0 },
  });
  render(<IntakePage client={engine([stored]).client} canRun />);
  const list = await screen.findByRole("list", { name: "Intake rules" });
  expect(list).toHaveTextContent("Every 15 minutes");
  expect(list).not.toHaveTextContent("Every 0 seconds");
});

it("opens a rule's form with what it holds", async () => {
  const user = userEvent.setup();
  const stored = rule({
    enabled: false,
    intake: {
      host: "github.com",
      repos: ["example-org/api"],
      label: "bug",
      assignees: ASSIGNEES.unassigned,
      authors: ["octo", "hubot"],
      intervalS: 1800,
    },
  });
  render(<IntakePage client={engine([stored]).client} canRun />);
  const dialog = await openEdit(user);
  expect(within(dialog).getByLabelText(/^Name/)).toHaveValue("Bugs");
  expect(within(dialog).getByLabelText(/^Label/)).toHaveValue("bug");
  expect(within(dialog).getByLabelText(/^Authors/)).toHaveValue("octo, hubot");
  expect(within(dialog).getByLabelText(/^Workflow/)).toHaveValue("rpi");
  expect(
    await within(dialog).findByRole("combobox", { name: "Repo" }),
  ).toHaveTextContent("example-org/api");
  expect(
    within(dialog).getByRole("combobox", { name: "Assigned to" }),
  ).toHaveTextContent("No one");
  expect(
    within(dialog).getByRole("combobox", { name: "Read the repo" }),
  ).toHaveTextContent("Every 30 minutes");
  expect(
    within(dialog).getByRole("switch", { name: "Rule is on" }),
  ).not.toBeChecked();
});

it("saves an edit with the assignee, interval and trimmed workflow it was given", async () => {
  const user = userEvent.setup();
  const e = engine();
  render(<IntakePage client={e.client} canRun />);
  const dialog = await openEdit(user);
  await choose(user, dialog, "Assigned to", "No one");
  await choose(user, dialog, "Read the repo", "Every hour");
  const workflow = within(dialog).getByLabelText(/^Workflow/);
  await user.clear(workflow);
  await user.type(workflow, "  ship  ");
  await user.click(within(dialog).getByRole("button", { name: "Save rule" }));
  expect(e.calls.saveIntakeRule).toHaveBeenCalledTimes(1);
  expect(e.calls.saveIntakeRule.mock.calls[0]?.[0]).toEqual({
    id: "r1",
    name: "Bugs",
    enabled: true,
    workflow: "ship",
    intake: {
      host: "github.com",
      repos: ["example-org/api"],
      label: "bug",
      assignees: ASSIGNEES.unassigned,
      authors: ["octo"],
      intervalS: 3600,
    },
  });
});

it("saves a stored rule with no interval at the engine's default, not 0", async () => {
  const user = userEvent.setup();
  const stored = rule({
    intake: { host: "github.com", repos: ["example-org/api"], intervalS: 0 },
  });
  const e = engine([stored]);
  render(<IntakePage client={e.client} canRun />);
  const dialog = await openEdit(user);
  expect(
    within(dialog).getByRole("combobox", { name: "Read the repo" }),
  ).toHaveTextContent("Every 15 minutes");
  await user.click(within(dialog).getByRole("button", { name: "Save rule" }));
  expect(e.calls.saveIntakeRule.mock.calls[0]?.[0]).toMatchObject({
    intake: { intervalS: DEFAULT_INTERVAL_S, assignees: ASSIGNEES.anyone },
  });
});

it("offers an interval the list does not know when a rule has one", async () => {
  const user = userEvent.setup();
  const stored = rule({
    intake: { host: "github.com", repos: ["example-org/api"], intervalS: 45 },
  });
  render(<IntakePage client={engine([stored]).client} canRun />);
  const dialog = await openEdit(user);
  expect(
    within(dialog).getByRole("combobox", { name: "Read the repo" }),
  ).toHaveTextContent("Every 45 seconds");
});

it("keeps the saved repo choosable when the token no longer lists it", async () => {
  const user = userEvent.setup();
  const stored = rule({
    intake: { host: "github.com", repos: ["example-org/gone"], intervalS: 900 },
  });
  const e = engine([stored]);
  render(<IntakePage client={e.client} canRun />);
  const dialog = await openEdit(user);
  const repo = await within(dialog).findByRole("combobox", { name: "Repo" });
  expect(repo).toHaveTextContent("example-org/gone");
  await user.click(repo);
  expect(
    await screen.findByRole("option", { name: "example-org/gone" }),
  ).toBeVisible();
  expect(screen.getByRole("option", { name: "example-org/api" })).toBeVisible();
});

it("says in the form when the repos cannot be read, and reads them again on Retry", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.listRepos.mockRejectedValueOnce(new Error("GitHub is not connected"));
  render(<IntakePage client={e.client} canRun />);
  const dialog = await openEdit(user);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "GitHub is not connected",
  );
  await user.click(within(dialog).getByRole("button", { name: "Retry" }));
  expect(
    await within(dialog).findByRole("combobox", { name: "Repo" }),
  ).toBeVisible();
  expect(e.calls.listRepos).toHaveBeenCalledTimes(2);
});
