// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
