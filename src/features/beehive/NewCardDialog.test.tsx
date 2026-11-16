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

const hit = (number: number, title: string, labels: string[] = []) => ({
  ref: { host: "github.com", owner: "example-org", repo: "api", number },
  title,
  state: "open",
  labels,
});

function engine() {
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
          hit(42, "Crash when saving a draft", ["bug"]),
          hit(43, "Add a retry"),
        ],
      }),
    ),
  };
  const onClose = vi.fn();
  render(
    <NewCardDialog client={client as unknown as Client} onClose={onClose} />,
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

it("still adds a written card, and reads nothing from GitHub to do it", async () => {
  const user = userEvent.setup();
  const e = engine();
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

it("finds the open issues of a chosen repo and adds a card from the one picked", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  expect(e.calls.searchIssues).toHaveBeenCalledWith(
    { repo: "example-org/api", text: "" },
    expect.anything(),
  );
  const radios = await screen.findAllByRole("radio");
  expect(radios).toHaveLength(2);
  expect(screen.getByText("#42 Crash when saving a draft")).toBeVisible();
  await user.click(screen.getByRole("radio", { name: /#42/ }));
  await user.click(screen.getByRole("button", { name: "Add card" }));
  expect(e.calls.createCard).toHaveBeenCalledWith({
    issue: { owner: "example-org", repo: "api", number: 42 },
    workflow: "",
  });
  expect(e.onClose).toHaveBeenCalled();
});

it("searches the text only when Search is pressed or Enter is typed, not on every key", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  await screen.findAllByRole("radio");
  expect(e.calls.searchIssues).toHaveBeenCalledTimes(1);
  await user.type(screen.getByLabelText(/^Search/), "draft");
  expect(e.calls.searchIssues).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Search" }));
  expect(e.calls.searchIssues).toHaveBeenLastCalledWith(
    { repo: "example-org/api", text: "draft" },
    expect.anything(),
  );
  await user.type(screen.getByLabelText(/^Search/), " x{Enter}");
  expect(e.calls.searchIssues).toHaveBeenLastCalledWith(
    { repo: "example-org/api", text: "draft x" },
    expect.anything(),
  );
  // Enter in the search box does not add a card.
  expect(e.calls.createCard).not.toHaveBeenCalled();
});

it("asks for an issue before it adds a card from one", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  await screen.findAllByRole("radio");
  await user.click(screen.getByRole("button", { name: "Add card" }));
  expect(await screen.findByText("Choose an issue.")).toBeVisible();
  expect(e.calls.createCard).not.toHaveBeenCalled();
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
  await user.click(screen.getByRole("tab", { name: "Write one" }));
  expect(screen.getByLabelText(/^Title/)).toBeVisible();
});

it("shows the engine's refusal when the card cannot be made from the issue", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.createCard.mockRejectedValueOnce(new Error("issue 42 was not found"));
  await openIssues(user);
  await chooseRepo(user);
  await user.click(await screen.findByRole("radio", { name: /#42/ }));
  await user.click(screen.getByRole("button", { name: "Add card" }));
  const dialog = screen.getByRole("dialog");
  expect(
    await within(dialog).findByText("issue 42 was not found"),
  ).toBeVisible();
  expect(e.onClose).not.toHaveBeenCalled();
});

const found = (...hits: ReturnType<typeof hit>[]) =>
  create(SearchIssuesResponseSchema, { issues: hits });

it("shows an issue's labels beside it", async () => {
  const user = userEvent.setup();
  engine();
  await openIssues(user);
  await chooseRepo(user);
  expect(await screen.findByRole("radio", { name: /#42/ })).toBeVisible();
  expect(screen.getByText("bug")).toBeVisible();
});

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
  expect(screen.queryByRole("radio")).toBeNull();
});

it("says no open issue matches, and offers nothing to pick", async () => {
  const user = userEvent.setup();
  const e = engine();
  e.calls.searchIssues.mockResolvedValueOnce(found());
  await openIssues(user);
  await chooseRepo(user);
  expect(await screen.findByText("No open issues match.")).toBeVisible();
  expect(screen.queryByRole("radio")).toBeNull();
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
  expect(screen.getByRole("radio", { name: /#42/ })).toBeVisible();
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
  await user.type(screen.getByLabelText(/^Search/), "retry");
  await user.click(screen.getByRole("button", { name: "Search" }));
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  await act(async () => {
    replies[1]?.(found(hit(43, "Add a retry")));
    replies[0]?.(found(hit(42, "Old answer")));
  });
  expect(await screen.findByRole("radio", { name: /#43/ })).toBeVisible();
  expect(screen.queryByRole("radio", { name: /#42/ })).toBeNull();
});

it("lets go of the picked issue when the person leaves the issue tab and comes back", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  await user.click(await screen.findByRole("radio", { name: /#42/ }));
  await user.click(screen.getByRole("tab", { name: "Write one" }));
  await openIssues(user);
  await user.click(screen.getByRole("button", { name: "Add card" }));
  expect(await screen.findByText("Choose an issue.")).toBeVisible();
  expect(e.calls.createCard).not.toHaveBeenCalled();
});

it("lets go of the picked issue when a new search no longer shows it", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  await user.click(await screen.findByRole("radio", { name: /#42/ }));
  expect(screen.getByRole("radio", { name: /#42/ })).toBeChecked();
  e.calls.searchIssues.mockResolvedValueOnce(found(hit(43, "Add a retry")));
  await user.type(screen.getByLabelText(/^Search/), "retry");
  await user.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByRole("radio", { name: /#43/ })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Add card" }));
  expect(await screen.findByText("Choose an issue.")).toBeVisible();
  expect(e.calls.createCard).not.toHaveBeenCalled();
});

it("lets go of the picked issue when the new search fails", async () => {
  const user = userEvent.setup();
  const e = engine();
  await openIssues(user);
  await chooseRepo(user);
  await user.click(await screen.findByRole("radio", { name: /#42/ }));
  e.calls.searchIssues.mockRejectedValueOnce(new Error("offline"));
  await user.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("offline")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add card" }));
  expect(await screen.findByText("Choose an issue.")).toBeVisible();
  expect(e.calls.createCard).not.toHaveBeenCalled();
});
