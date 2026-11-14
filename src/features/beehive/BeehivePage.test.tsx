// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { BeehivePage } from "./BeehivePage";
import type { Client } from "./engine/client";
import {
  CardSchema,
  EventSchema,
  CheckWorkflowResponseSchema,
  ListCardsResponseSchema,
  ListWorkflowsResponseSchema,
  PollEventsResponseSchema,
  WhoAmIResponseSchema,
  type Card,
} from "./gen/kiln/engine/v1/engine_pb";
import { PAGE_ID, PLUGIN_ID } from "./routes";

afterEach(cleanup);

const ID = "0b8f4d1e-6c1f-4f0e-9d53-2f3f6a0a1c11";
const card = (fields: MessageInitShape<typeof CardSchema> = {}) =>
  create(CardSchema, { id: ID, title: "Fix the build", ...fields });

/** A Beehive with a parked long poll the test can answer. */
function engine(options: { cards?: Card[]; role?: string; seq?: bigint } = {}) {
  const polls: { after: bigint; answer(events: Card[], type: string): void }[] =
    [];
  const client = {
    listCards: vi.fn(async (archived = false) =>
      create(ListCardsResponseSchema, {
        cards: (options.cards ?? []).filter((c) => c.archived === archived),
        seq: options.seq ?? 5n,
      }),
    ),
    whoAmI: vi.fn(async () =>
      create(WhoAmIResponseSchema, { role: options.role ?? "run" }),
    ),
    listWorkflows: vi.fn(async () =>
      create(ListWorkflowsResponseSchema, {
        workflows: [{ name: "demo", ok: true, builtin: true }],
      }),
    ),
    checkWorkflow: vi.fn(async () => create(CheckWorkflowResponseSchema, {})),
    getCard: vi.fn(async () => card({ body: "Line one\nLine two" })),
    createCard: vi.fn(async () => card()),
    archiveCards: vi.fn(async () => ({})),
    restoreCard: vi.fn(async () => card()),
    pollEvents: vi.fn(
      (after: bigint) =>
        new Promise((resolve) =>
          polls.push({
            after,
            answer: (cards, type) =>
              resolve(
                create(PollEventsResponseSchema, {
                  events: cards.map((c, i) =>
                    create(EventSchema, {
                      seq: after + BigInt(i + 1),
                      type,
                      cardId: c.id,
                      payloadJson: JSON.stringify({
                        title: c.title,
                        workflow: c.workflow,
                        state: c.state,
                      }),
                    }),
                  ),
                  nextSeq: after + BigInt(cards.length),
                }),
              ),
          }),
        ),
    ),
  };
  return { client: client as unknown as Client, calls: client, polls };
}

const board: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: PLUGIN_ID,
  pageId: PAGE_ID,
};
const cardView: OpenTarget = {
  ...board,
  route: { version: 1, params: { card: ID } },
} as OpenTarget;

function shell(target: OpenTarget = board) {
  const navigator = { open: vi.fn(async () => ({})), dismiss: vi.fn() };
  return {
    navigator: navigator as unknown as Navigation,
    mock: navigator,
    navigation: {
      entryId: "visit-1",
      target,
      signal: new AbortController().signal,
    } as never,
  };
}

function page(client: Client, target?: OpenTarget) {
  const s = shell(target);
  render(
    <BeehivePage
      client={client}
      navigation={s.navigation}
      navigator={s.navigator}
    />,
  );
  return s.mock;
}

it("keeps the header and shows the empty state when there are no cards", async () => {
  page(engine().client);
  expect(await screen.findByText("No cards yet")).toBeVisible();
  expect(screen.getByRole("region", { name: "Beehive" })).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("puts a card without a workflow in Backlog and one with a workflow in To do", async () => {
  page(
    engine({
      cards: [
        card({ id: "a", title: "Loose idea" }),
        card({ id: "b", title: "Ready work", workflow: "ship", state: "idle" }),
      ],
    }).client,
  );
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  expect(within(backlog).getByText("Loose idea")).toBeVisible();
  const todo = screen.getByRole("region", { name: "To do" });
  expect(within(todo).getByText("Ready work")).toBeVisible();
});

it("shows the failure beside the board and retries on request", async () => {
  const e = engine();
  e.calls.listCards.mockRejectedValueOnce(
    new Error("Beehive is not reachable"),
  );
  page(e.client);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  expect(screen.queryByText("No cards yet")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No cards yet")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(e.calls.listCards).toHaveBeenCalledTimes(2);
});

it("follows the event log from the sequence number the list returned", async () => {
  const e = engine({ seq: 12n });
  page(e.client);
  await screen.findByText("No cards yet");
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  expect(e.polls[0]?.after).toBe(12n);
  e.polls[0]?.answer([card({ title: "From another person" })], "card.created");
  expect(await screen.findByText("From another person")).toBeVisible();
  expect(screen.queryByText("No cards yet")).toBeNull();
  await vi.waitFor(() => expect(e.polls).toHaveLength(2));
  expect(e.polls[1]?.after).toBe(13n);
  e.polls[1]?.answer([card()], "card.archived");
  await screen.findByText("No cards yet");
});

it("lists archived cards in the Archive view", async () => {
  const e = engine({ cards: [card({ archived: true })] });
  page(e.client);
  await screen.findByText("No cards yet");
  await userEvent.click(screen.getByRole("tab", { name: "Archive" }));
  expect(await screen.findByText("Fix the build")).toBeVisible();
  expect(e.calls.listCards).toHaveBeenLastCalledWith(true, expect.anything());
});

it("lists the workflows from the Workflows view and returns to the board", async () => {
  const e = engine({ cards: [card()] });
  page(e.client);
  await screen.findByText("Fix the build");
  await userEvent.click(screen.getByRole("tab", { name: "Workflows" }));
  expect(await screen.findByRole("region", { name: "demo" })).toBeVisible();
  expect(screen.queryByText("Fix the build")).toBeNull();
  await userEvent.click(screen.getByRole("tab", { name: "Board" }));
  expect(await screen.findByText("Fix the build")).toBeVisible();
  // The board kept its read: switching views did not read the cards again.
  expect(e.calls.listCards).toHaveBeenCalledTimes(1);
});

it("offers New card only to someone who can run", async () => {
  const reader = engine({ role: "read" });
  page(reader.client);
  await screen.findByText("No cards yet");
  await vi.waitFor(() => expect(reader.calls.whoAmI).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "New card" })).toBeNull();
  cleanup();
  page(engine({ role: "run" }).client);
  expect(
    (await screen.findAllByRole("button", { name: "New card" })).length,
  ).toBeGreaterThan(0);
});

it("asks for a title before adding a card", async () => {
  const e = engine();
  page(e.client);
  await userEvent.click(
    (
      await screen.findAllByRole("button", { name: "New card" })
    )[0] as HTMLElement,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add card" }));
  expect(await screen.findByText("Enter a title for the card.")).toBeVisible();
  expect(e.calls.createCard).not.toHaveBeenCalled();
});

it("adds a card with the entered values and closes the form", async () => {
  const e = engine();
  page(e.client);
  await userEvent.click(
    (
      await screen.findAllByRole("button", { name: "New card" })
    )[0] as HTMLElement,
  );
  await userEvent.type(screen.getByLabelText("Title"), "  Write the docs  ");
  await userEvent.type(screen.getByLabelText(/Description/), "Cover the API");
  await userEvent.click(screen.getByRole("button", { name: "Add card" }));
  await vi.waitFor(() =>
    expect(e.calls.createCard).toHaveBeenCalledWith({
      title: "Write the docs",
      description: "Cover the API",
      workflow: "",
    }),
  );
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps the form and what was typed when Beehive refuses the card", async () => {
  const e = engine();
  e.calls.createCard.mockRejectedValueOnce(new Error("workflow is unknown"));
  page(e.client);
  await userEvent.click(
    (
      await screen.findAllByRole("button", { name: "New card" })
    )[0] as HTMLElement,
  );
  await userEvent.type(screen.getByLabelText("Title"), "Write the docs");
  await userEvent.click(screen.getByRole("button", { name: "Add card" }));
  expect(await screen.findByText("workflow is unknown")).toBeVisible();
  expect(screen.getByLabelText("Title")).toHaveValue("Write the docs");
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("opens a card as a visit of the page", async () => {
  const nav = page(engine({ cards: [card()] }).client);
  await userEvent.click(
    await screen.findByRole("button", { name: /Fix the build/ }),
  );
  expect(nav.open).toHaveBeenCalledWith({
    ...board,
    route: { version: 1, params: { card: ID } },
  });
});

it("shows a card's details when its visit is shown, keeping the board mounted", async () => {
  const e = engine({ cards: [card()] });
  page(e.client, cardView);
  expect(await screen.findByRole("tab", { name: "Details" })).toBeVisible();
  expect(await screen.findByText(/Line one/)).toBeVisible();
  expect(e.calls.getCard).toHaveBeenCalledWith(ID, expect.anything());
  // The board keeps its place and its live poll while the card is open.
  expect(e.calls.listCards).toHaveBeenCalled();
});

it("archives the open card and restores it", async () => {
  const e = engine();
  e.calls.getCard
    .mockResolvedValueOnce(card())
    .mockResolvedValueOnce(card({ archived: true }));
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
  await vi.waitFor(() =>
    expect(e.calls.archiveCards).toHaveBeenCalledWith([ID]),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
  await vi.waitFor(() => expect(e.calls.restoreCard).toHaveBeenCalledWith(ID));
});

it("Close retires the card's visits and falls back to the board", async () => {
  const nav = page(engine().client, cardView);
  await userEvent.click(
    await screen.findByRole("button", { name: "Close card" }),
  );
  expect(nav.dismiss).toHaveBeenCalledTimes(1);
  const [retire, fallback] = nav.dismiss.mock.calls[0] as unknown as [
    (target: OpenTarget) => boolean,
    OpenTarget,
  ];
  expect(retire(cardView)).toBe(true);
  expect(retire(board)).toBe(false);
  expect(fallback).toEqual(board);
});

it("says so when the card cannot be read", async () => {
  const e = engine();
  e.calls.getCard.mockRejectedValue(new Error("card does not exist"));
  page(e.client, cardView);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "card does not exist",
  );
});
