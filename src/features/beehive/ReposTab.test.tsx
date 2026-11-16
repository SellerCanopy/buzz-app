// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it, vi } from "vitest";
import type { Client } from "./engine/client";
import { EngineError } from "./engine/transport";
import { CardSchema } from "./gen/kiln/engine/v1/engine_pb";
import { ReposTab } from "./ReposTab";

afterEach(cleanup);

const ref = (owner: string, repo: string) => ({
  host: "github.com",
  owner,
  repo,
});
const card = (fields: Record<string, unknown> = {}) =>
  create(CardSchema, {
    id: "c1",
    title: "Rename the gateway headers",
    issue: { ...ref("example-org", "upload-api"), number: 212 },
    ...fields,
  });
/** A card with two repos: the issue's, with a pull request, and one added. */
const two = (fields: Record<string, unknown> = {}) =>
  card({
    repos: [
      {
        repo: ref("example-org", "upload-api"),
        main: true,
        pullRequest: {
          number: 231,
          url: "https://github.com/example-org/upload-api/pull/231",
          state: "open",
          draft: true,
        },
        checks: "passing",
        removeRefusal: "it is the repo of the card's issue",
      },
      { repo: ref("example-org", "gateway"), mergeOrder: 2 },
    ],
    ...fields,
  });

function show(
  options: {
    card?: ReturnType<typeof card>;
    canRun?: boolean;
    client?: Partial<Record<"addIssueRepo" | "removeIssueRepo", unknown>>;
  } = {},
) {
  const onChanged = vi.fn();
  const client = {
    addIssueRepo: vi.fn(async () => two()),
    removeIssueRepo: vi.fn(async () => card()),
    ...options.client,
  };
  render(
    <ReposTab
      client={client as unknown as Client}
      card={options.card ?? two()}
      canRun={options.canRun ?? true}
      onChanged={onChanged}
    />,
  );
  return { client, onChanged };
}

/** The dialog's own button, since the page behind a modal is hidden from the accessibility tree. */
const submit = () =>
  userEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Add repo",
    }),
  );

const list = () => screen.getByRole("list", { name: "Repos of the card" });

it("lists the repos in order with the pull request of each that has one", () => {
  show();
  const rows = within(list()).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("1. example-org/upload-api");
  expect(rows[0]).toHaveTextContent("Main");
  expect(rows[0]).toHaveTextContent("#231 draft · checks passing");
  expect(within(rows[0] as HTMLElement).getByRole("link")).toHaveAttribute(
    "href",
    "https://github.com/example-org/upload-api/pull/231",
  );
  expect(rows[1]).toHaveTextContent("2. example-org/gateway");
  expect(rows[1]).not.toHaveTextContent("#");
});

it("shows a card's only repo from its issue, which the engine leaves out of repos", () => {
  show({
    card: card({
      pullRequest: { number: 9, url: "", state: "merged", draft: false },
    }),
  });
  const rows = within(list()).getAllByRole("listitem");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent("1. example-org/upload-api");
  expect(rows[0]).toHaveTextContent("#9 merged");
});

it("adds a repo with the engine and hands the card it returns to the page", async () => {
  const { client, onChanged } = show();
  await userEvent.click(screen.getByRole("button", { name: "Add repo" }));
  await userEvent.type(screen.getByLabelText("Repo"), "  example-org/web ");
  await submit();
  expect(client.addIssueRepo).toHaveBeenCalledWith("c1", "example-org/web");
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each(["web", "a/b/c", "a/..", "../web", "a/b?x", "a b/c", ""])(
  "refuses %j before asking the engine",
  async (typed) => {
    const { client } = show();
    await userEvent.click(screen.getByRole("button", { name: "Add repo" }));
    if (typed) await userEvent.type(screen.getByLabelText("Repo"), typed);
    await submit();
    expect(
      await screen.findByText("Type the repo as owner/name."),
    ).toBeVisible();
    expect(client.addIssueRepo).not.toHaveBeenCalled();
  },
);

it("says what the engine said when it refuses a repo, and keeps the form for another try", async () => {
  const { onChanged } = show({
    client: {
      addIssueRepo: vi.fn(async () => {
        throw new EngineError(
          "not_found",
          "example-org/nope does not exist or cannot be read",
          404,
        );
      }),
    },
  });
  await userEvent.click(screen.getByRole("button", { name: "Add repo" }));
  await userEvent.type(screen.getByLabelText("Repo"), "example-org/nope");
  await submit();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "example-org/nope does not exist or cannot be read",
  );
  expect(screen.getByLabelText("Repo")).toHaveValue("example-org/nope");
  expect(onChanged).not.toHaveBeenCalled();
});

it("removes an extra repo with the engine", async () => {
  const { client, onChanged } = show();
  await userEvent.click(
    screen.getByRole("button", { name: "Remove example-org/gateway" }),
  );
  expect(client.removeIssueRepo).toHaveBeenCalledWith(
    "c1",
    "example-org/gateway",
  );
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

it("says why a repo cannot be removed, and does not offer to", () => {
  show({
    card: two({
      repos: [
        {
          repo: ref("example-org", "upload-api"),
          main: true,
        },
        {
          repo: ref("example-org", "gateway"),
          removeRefusal: "it has an open pull request",
        },
      ],
    }),
  });
  expect(
    screen.getByText("Cannot remove: it has an open pull request."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Remove example-org/gateway" }),
  ).toBeDisabled();
});

it("says what the engine said when it refuses a removal it could not tell of before", async () => {
  const { onChanged } = show({
    client: {
      removeIssueRepo: vi.fn(async () => {
        throw new EngineError(
          "failed_precondition",
          "the card has an active run; its repos change when the run ends",
          400,
        );
      }),
    },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Remove example-org/gateway" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the card has an active run; its repos change when the run ends",
  );
  expect(onChanged).not.toHaveBeenCalled();
  // The button works again.
  expect(
    screen.getByRole("button", { name: "Remove example-org/gateway" }),
  ).toBeEnabled();
});

it("shows a person who can only read the repos with no way to change them", () => {
  show({ canRun: false });
  expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Add repo" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  expect(screen.queryByText(/Cannot remove/)).toBeNull();
});

it("says so when a card has no repos", () => {
  show({ card: card({ issue: undefined }) });
  expect(screen.getByText("No repos on this card.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add repo" })).toBeVisible();
});
