// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { Client } from "./engine/client";
import {
  CardSchema,
  IssueCommentSchema,
  ListIssueCommentsResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";
import { IssueTab, issueName } from "./IssueTab";

afterEach(cleanup);

const card = (fields: Record<string, unknown> = {}) =>
  create(CardSchema, {
    id: "c1",
    title: "Crash when saving a draft",
    body: "Steps:\n1. Open a draft\n2. Press save",
    issue: {
      host: "github.com",
      owner: "example-org",
      repo: "api",
      number: 42,
    },
    issueLabels: ["bug", "kiln"],
    ...fields,
  });

function show(
  comments: Record<string, unknown>[],
  options: { truncated?: boolean; card?: ReturnType<typeof card> } = {},
) {
  const listIssueComments = vi.fn(async () =>
    create(ListIssueCommentsResponseSchema, {
      comments: comments.map((c) => create(IssueCommentSchema, c)),
      truncated: options.truncated ?? false,
    }),
  );
  render(
    <IssueTab
      client={{ listIssueComments } as unknown as Client}
      card={options.card ?? card()}
    />,
  );
  return listIssueComments;
}

it("shows the issue, its labels and its text, then the comments with who wrote them", async () => {
  const read = show([
    { id: "1", author: "octo", body: "I can reproduce this." },
    { id: "2", author: "hive", body: "Picked up.", fromHive: true },
  ]);
  expect(screen.getByText("example-org/api#42")).toBeVisible();
  expect(screen.getByText("bug, kiln")).toBeVisible();
  expect(screen.getByText(/Open a draft/)).toBeVisible();
  const comments = await screen.findByRole("region", { name: "Comments" });
  const rows = within(comments).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("octo");
  expect(rows[0]).toHaveTextContent("I can reproduce this.");
  // A comment Beehive wrote is named Beehive, not by the account that posted it.
  expect(rows[1]).toHaveTextContent("Beehive");
  expect(rows[1]).not.toHaveTextContent("hive,");
  expect(read).toHaveBeenCalledWith("c1", expect.anything());
});

it("shows text from the host as plain text, never as markup or a link", async () => {
  show([
    {
      id: "1",
      author: "mallory",
      body: '<img src=x onerror="alert(1)"> [click](https://example.org/x)',
    },
  ]);
  const comments = await screen.findByRole("region", { name: "Comments" });
  expect(comments.querySelector("img")).toBeNull();
  expect(comments.querySelector("a")).toBeNull();
  expect(comments).toHaveTextContent(
    '<img src=x onerror="alert(1)"> [click](https://example.org/x)',
  );
});

it("says why a card left its rule and when the issue has more comments", async () => {
  show([], {
    truncated: true,
    card: card({ intakeStatus: "closed" }),
  });
  expect(await screen.findByText("No comments on the issue.")).toBeVisible();
  expect(screen.getByText("The issue was closed.")).toBeVisible();
  expect(
    screen.getByText("The issue has more comments. These are the newest."),
  ).toBeVisible();
});

it("shows the engine's words when the comments cannot be read, and reads again on Retry", async () => {
  const listIssueComments = vi
    .fn()
    .mockRejectedValueOnce(new Error("GitHub is not connected"))
    .mockResolvedValueOnce(
      create(ListIssueCommentsResponseSchema, {
        comments: [create(IssueCommentSchema, { id: "1", body: "Back." })],
      }),
    );
  render(
    <IssueTab
      client={{ listIssueComments } as unknown as Client}
      card={card()}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "GitHub is not connected",
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Back.")).toBeVisible();
  // The text of the issue stays on screen while the comments fail.
  expect(screen.getByText(/Open a draft/)).toBeVisible();
});

it("names an issue as owner/repo#number", () => {
  expect(issueName(card())).toBe("example-org/api#42");
  expect(issueName(create(CardSchema, { id: "c" }))).toBe("");
});
