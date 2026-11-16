// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { Client } from "./engine/client";
import {
  CardSchema,
  ListReposResponseSchema,
  SearchIssuesResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";
import { NewCardDialog } from "./NewCardDialog";

afterEach(cleanup);

const hit = (
  number: number,
  title: string,
  labels: string[] = [],
  assignees: string[] = [],
) => ({
  ref: { host: "github.com", owner: "example-org", repo: "api", number },
  title,
  state: "open",
  labels,
  assignees,
});

function engine(initial?: "blank" | "issue") {
  const client = {
    createCard: vi.fn(async () => create(CardSchema, { id: "c1" })),
    listRepos: vi.fn(async () =>
      create(ListReposResponseSchema, {
        repos: ["example-org/api", "example-org/web"],
      }),
    ),
    searchIssues: vi.fn(async () =>
      create(SearchIssuesResponseSchema, {
        issues: [
          hit(42, "Crash when saving a draft", ["bug"], ["ada-m"]),
          hit(43, "Add a retry"),
        ],
      }),
    ),
  };
  const onClose = vi.fn();
  render(
    <NewCardDialog
      client={client as unknown as Client}
      onClose={onClose}
      {...(initial ? { initial } : {})}
    />,
  );
  return { calls: client, onClose };
}

async function openIssues(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("tab", { name: "From an issue" }));
}

async function chooseRepo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("combobox", { name: "Repo" }));
  await user.click(
    await screen.findByRole("option", { name: "example-org/api" }),
  );
}

it("opens on a blank card with its subtitle, and adds a written card without reading GitHub", async () => {
  const user = userEvent.setup();
  const e = engine();
  expect(
    await screen.findByText("Cards wait in Backlog until you pick a workflow."),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Blank card" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.type(await screen.findByLabelText(/^Title/), "Fix login");
  await user.click(screen.getByRole("button", { name: "Add card" }));
  expect(e.calls.createCard).toHaveBeenCalledWith({
    title: "Fix login",
    description: "",
    workflow: "",
  });
  expect(e.calls.listRepos).not.toHaveBeenCalled();
  expect(e.onClose).toHaveBeenCalled();
});

it("opens on the From an issue tab when asked, with its subtitle and a Close button", async () => {
  engine("issue");
  expect(
    await screen.findByText(
      "Search issues, then take one. The card keeps its title, text and comments.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "From an issue" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByRole("button", { name: "Add card" })).toBeNull();
  // The dialog's own close control and the footer's Close.
  expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
});

it("asks for a title before it adds a written card", async () => {
  const user = userEvent.setup();
  const e = engine();
  await user.click(await screen.findByRole("button", { name: "Add card" }));
  expect(await screen.findByText("Enter a title for the card.")).toBeVisible();
  expect(e.calls.createCard).not.toHaveBeenCalled();
});

it("finds the open issues of a chosen repo and makes a card of the one taken", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  expect(e.calls.searchIssues).toHaveBeenCalledWith(
    {
      repos: ["example-org/api"],
      text: "",
      label: "",
      assignee: "",
      state: "open",
    },
    expect.anything(),
  );
  const rows = await screen.findAllByRole("button", { name: /^Take/ });
  expect(rows).toHaveLength(2);
  const list = screen.getByRole("list", { name: "Issues" });
  expect(within(list).getByText("Crash when saving a draft")).toBeVisible();
  expect(within(list).getByText(/example-org\/api#42/)).toBeVisible();
  expect(within(list).getByText(/bug/)).toBeVisible();
  expect(within(list).getByText(/Assigned to ada-m/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^Take #42/ }));
  expect(e.calls.createCard).toHaveBeenCalledWith({
    issue: { owner: "example-org", repo: "api", number: 42 },
  });
  expect(e.onClose).toHaveBeenCalled();
});

it("searches with the text, label, state and assignee only when Search is pressed or Enter is typed", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  await screen.findAllByRole("button", { name: /^Take/ });
  expect(e.calls.searchIssues).toHaveBeenCalledTimes(1);
  await user.type(screen.getByLabelText(/^Text/), "draft");
  await user.type(screen.getByLabelText(/^Label/), "bug");
  await user.type(screen.getByLabelText(/^Assignee/), "none");
  expect(e.calls.searchIssues).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("combobox", { name: "State" }));
  await user.click(await screen.findByRole("option", { name: "Closed" }));
  await user.click(screen.getByRole("button", { name: "Search" }));
  expect(e.calls.searchIssues).toHaveBeenLastCalledWith(
    {
      repos: ["example-org/api"],
      text: "draft",
      label: "bug",
      assignee: "none",
      state: "closed",
    },
    expect.anything(),
  );
  await user.type(screen.getByLabelText(/^Text/), " x{Enter}");
  expect(e.calls.searchIssues).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: "draft x" }),
    expect.anything(),
  );
  // Enter in a field does not take an issue.
  expect(e.calls.createCard).not.toHaveBeenCalled();
});

it("searches open and closed issues when the state is Any", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  await screen.findAllByRole("button", { name: /^Take/ });
  await user.click(screen.getByRole("combobox", { name: "State" }));
  await user.click(await screen.findByRole("option", { name: "Any" }));
  await user.click(screen.getByRole("button", { name: "Search" }));
  expect(e.calls.searchIssues).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: "" }),
    expect.anything(),
  );
});

it("says in the engine's words that GitHub is not connected, and keeps the dialog open", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.listRepos.mockRejectedValueOnce(
    new Error("GitHub is not connected: set GH_TOKEN"),
  );
  await openIssues(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "GitHub is not connected: set GH_TOKEN",
  );
  expect(e.onClose).not.toHaveBeenCalled();
  // The written form is one tab away.
  await user.click(screen.getByRole("tab", { name: "Blank card" }));
  expect(screen.getByLabelText(/^Title/)).toBeVisible();
});

it("shows the engine's refusal when the card cannot be made from the issue", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.createCard.mockRejectedValueOnce(new Error("issue 42 was not found"));
  await openIssues(user);
  await chooseRepo(user);
  await user.click(await screen.findByRole("button", { name: /^Take #42/ }));
  const dialog = screen.getByRole("dialog");
  expect(
    await within(dialog).findByText("issue 42 was not found"),
  ).toBeVisible();
  expect(e.onClose).not.toHaveBeenCalled();
  // The issue can be taken again.
  expect(screen.getByRole("button", { name: /^Take #42/ })).toBeEnabled();
});

const found = (...hits: ReturnType<typeof hit>[]) =>
  create(SearchIssuesResponseSchema, { issues: hits });

it("says in the engine's words when the issues cannot be found", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.searchIssues.mockRejectedValueOnce(
    new Error("GitHub rate limit: try again in 5 minutes"),
  );
  await openIssues(user);
  await chooseRepo(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "GitHub rate limit: try again in 5 minutes",
  );
  expect(screen.queryByRole("button", { name: /^Take/ })).toBeNull();
});

it("says no issue matches, and offers nothing to take", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.searchIssues.mockResolvedValueOnce(found());
  await openIssues(user);
  await chooseRepo(user);
  expect(await screen.findByText("No issues match.")).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Take/ })).toBeNull();
});

it("says more issues match when the engine names a next page, or says the list is cut short", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.searchIssues.mockResolvedValueOnce(
    create(SearchIssuesResponseSchema, {
      issues: [hit(42, "One")],
      nextCursor: "page-2",
    }),
  );
  await openIssues(user);
  await chooseRepo(user);
  expect(await screen.findByText(/More issues match/)).toBeVisible();
  e.calls.searchIssues.mockResolvedValueOnce(
    create(SearchIssuesResponseSchema, {
      issues: [hit(42, "One")],
      truncated: true,
    }),
  );
  await user.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText(/More issues match/)).toBeVisible();
  e.calls.searchIssues.mockResolvedValueOnce(found(hit(42, "One")));
  await user.click(screen.getByRole("button", { name: "Search" }));
  await vi.waitFor(() =>
    expect(screen.queryByText(/More issues match/)).toBeNull(),
  );
  expect(screen.getByRole("button", { name: /^Take #42/ })).toBeVisible();
});

it("says the repo list is partial when the engine cut it short", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.listRepos.mockResolvedValueOnce(
    create(ListReposResponseSchema, {
      repos: ["example-org/api"],
      truncated: true,
    }),
  );
  await openIssues(user);
  expect(
    await screen.findByText(
      "The list is partial. A repo that is missing may still exist.",
    ),
  ).toBeVisible();
});

it("reads the repos again when Retry is pressed after a failure", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.listRepos.mockRejectedValueOnce(new Error("offline"));
  await openIssues(user);
  await user.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("combobox", { name: "Repo" })).toBeVisible();
  expect(e.calls.listRepos).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows the newest search when an older one answers last", async () => {
  const user = userEvent.setup();
  const e = engine();
  const replies: ((hits: ReturnType<typeof found>) => void)[] = [];
  e.calls.searchIssues.mockImplementation(
    () =>
      new Promise((resolve) => {
        replies.push(resolve as never);
      }),
  );
  await openIssues(user);
  await chooseRepo(user);
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  await user.type(screen.getByLabelText(/^Text/), "retry");
  await user.click(screen.getByRole("button", { name: "Search" }));
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  await act(async () => {
    replies[1]?.(found(hit(43, "Add a retry")));
    replies[0]?.(found(hit(42, "Old answer")));
  });
  expect(
    await screen.findByRole("button", { name: /^Take #43/ }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Take #42/ })).toBeNull();
});
