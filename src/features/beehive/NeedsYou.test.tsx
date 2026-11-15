// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { BeehiveViews } from "./BeehiveViews";
import type { Client } from "./engine/client";
import { GateCard } from "./GateCard";
import { artifactsOf } from "./labels";
import {
  EventSchema,
  InboxItemSchema,
  ListCardsResponseSchema,
  ListInboxResponseSchema,
  PollEventsResponseSchema,
  type InboxItem,
} from "./gen/kiln/engine/v1/engine_pb";
import { fakeRelay } from "./fake-relay";

afterEach(cleanup);

it("lists an approval's artifacts by name, with the version when it has one", () => {
  expect(artifactsOf(JSON.stringify({ artifacts: ["plan", ""] }))).toEqual([
    "plan",
  ]);
  expect(
    artifactsOf(JSON.stringify({ artifacts: [{ name: "plan", version: 2 }] })),
  ).toEqual(["plan (version 2)"]);
  expect(artifactsOf("not json")).toEqual([]);
  expect(artifactsOf("{}")).toEqual([]);
});

const item = (fields: MessageInitShape<typeof InboxItemSchema> = {}) =>
  create(InboxItemSchema, {
    id: "item-1",
    kind: "approval",
    cardId: "card-1",
    cardTitle: "Write the docs",
    stage: "gate",
    state: "open",
    title: "plan is waiting for approval",
    detailJson: JSON.stringify({ artifacts: ["plan", "sketch"] }),
    choices: ["approve", "reject"],
    ...fields,
  });

function card(
  options: {
    item?: InboxItem;
    canRun?: boolean;
    onAnswer?: (...args: unknown[]) => Promise<void>;
  } = {},
) {
  const onAnswer = vi.fn(options.onAnswer ?? (async () => undefined));
  const onOpenCard = vi.fn();
  render(
    <GateCard
      item={options.item ?? item()}
      canRun={options.canRun ?? true}
      onOpenCard={onOpenCard}
      onAnswer={onAnswer as never}
    />,
  );
  return { onAnswer, onOpenCard };
}

it("shows what waits and approves with one press", async () => {
  const { onAnswer } = card();
  expect(
    screen.getByRole("region", { name: "Approval: Write the docs" }),
  ).toBeVisible();
  expect(screen.getByText("plan is waiting for approval")).toBeVisible();
  expect(screen.getByText("To approve: plan, sketch")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(onAnswer).toHaveBeenCalledWith(expect.anything(), "approve", "");
});

it("keeps Reject off until the reason has words, then sends it", async () => {
  const user = userEvent.setup();
  const { onAnswer } = card();
  await user.click(screen.getByRole("button", { name: "Reject" }));
  const dialog = await screen.findByRole("dialog");
  const send = within(dialog).getByRole("button", { name: "Reject" });
  expect(send).toBeDisabled();
  const reason = within(dialog).getByRole("textbox", { name: /Reason/ });
  await waitFor(() => expect(reason).toHaveFocus());
  await user.type(reason, "   ");
  expect(send).toBeDisabled();
  await user.type(reason, "Add a rollback step.");
  expect(send).toBeEnabled();
  await user.click(send);
  expect(onAnswer).toHaveBeenCalledWith(
    expect.anything(),
    "reject",
    "Add a rollback step.",
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps the dialog and the words when the engine refuses the answer", async () => {
  const user = userEvent.setup();
  card({
    onAnswer: async () => {
      throw new Error("the run moved on; the item is out of date");
    },
  });
  await user.click(screen.getByRole("button", { name: "Reject" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByRole("textbox"), "Not yet.");
  await user.click(within(dialog).getByRole("button", { name: "Reject" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "the run moved on",
  );
  expect(within(dialog).getByRole("textbox")).toHaveValue("Not yet.");
});

it("asks for a reply to a question and for nothing on a skip", async () => {
  const user = userEvent.setup();
  const { onAnswer } = card({
    item: item({
      kind: "question",
      title: "Which database?",
      detailJson: "{}",
      choices: ["reply", "skip", "stop"],
    }),
  });
  await user.click(screen.getByRole("button", { name: "Skip stage" }));
  expect(onAnswer).toHaveBeenCalledWith(expect.anything(), "skip", "");
  await user.click(screen.getByRole("button", { name: "Reply" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByRole("textbox"), "Postgres.");
  await user.click(within(dialog).getByRole("button", { name: "Reply" }));
  expect(onAnswer).toHaveBeenLastCalledWith(
    expect.anything(),
    "reply",
    "Postgres.",
  );
});

it("asks before it stops a run", async () => {
  const user = userEvent.setup();
  const { onAnswer } = card({
    item: item({
      kind: "route",
      title: "The workflow asks where to go",
      detailJson: "{}",
      choices: ["skip", "stop"],
    }),
  });
  await user.click(screen.getByRole("button", { name: "Stop run" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(onAnswer).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(onAnswer).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Stop run" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Stop run",
    }),
  );
  expect(onAnswer).toHaveBeenCalledWith(expect.anything(), "stop", "");
});

it("lets a person who cannot run read the item and open the card, nothing more", async () => {
  const { onOpenCard } = card({ canRun: false });
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open card" }));
  expect(onOpenCard).toHaveBeenCalledWith("card-1");
});

/** The Beehive views over a fake engine whose inbox list and long poll the test controls. */
function views(initial: InboxItem[], options: { failFirst?: string } = {}) {
  let open = initial;
  const polls: {
    after: bigint;
    signal: AbortSignal | undefined;
    answer(types: [string, ...string[]]): void;
  }[] = [];
  const calls = {
    listCards: vi.fn(async () =>
      create(ListCardsResponseSchema, { cards: [], seq: 5n }),
    ),
    listInbox: vi.fn(async () =>
      create(ListInboxResponseSchema, { items: open, seq: 900_000n }),
    ),
    answerInbox: vi.fn(async (id: string) => {
      open = open.filter((entry) => entry.id !== id);
      return create(InboxItemSchema, { id, state: "resolved" });
    }),
    pollEvents: vi.fn(
      (after: bigint, _wait?: number, signal?: AbortSignal) =>
        new Promise((resolve) =>
          // The board's poll is parked for good; only the inbox's can be answered.
          after < 900_000n
            ? undefined
            : polls.push({
                after,
                signal,
                answer: (types) =>
                  resolve(
                    create(PollEventsResponseSchema, {
                      events: types.map((type, index) =>
                        create(EventSchema, {
                          seq: after + BigInt(index + 1),
                          type,
                        }),
                      ),
                      nextSeq: after + BigInt(types.length),
                    }),
                  ),
              }),
        ),
    ),
  };
  if (options.failFirst)
    calls.listInbox.mockRejectedValueOnce(new Error(options.failFirst));
  render(
    <BeehiveViews
      client={calls as unknown as Client}
      relay={fakeRelay([])}
      canRun
      isAdmin={false}
      onOpen={vi.fn()}
      onNew={vi.fn()}
    />,
  );
  return {
    calls,
    polls,
    set: (next: InboxItem[]) => {
      open = next;
    },
  };
}

it("counts the open items on the Needs you tab", async () => {
  views([item(), item({ id: "item-2", kind: "question", choices: ["reply"] })]);
  expect(
    await screen.findByRole("img", { name: "2 items need you" }),
  ).toBeVisible();
});

it("shows no count when nothing waits", async () => {
  const e = views([]);
  await waitFor(() => expect(e.calls.listInbox).toHaveBeenCalled());
  await waitFor(() => expect(e.polls).toHaveLength(1));
  expect(screen.queryByRole("img", { name: /need/ })).toBeNull();
});

it("follows the event log: an opened item raises the count and a resolved one lowers it", async () => {
  const e = views([item()]);
  expect(
    await screen.findByRole("img", { name: "1 item needs you" }),
  ).toBeVisible();
  await waitFor(() => expect(e.polls).toHaveLength(1));
  expect(e.polls[0]?.after).toBe(900_000n);

  e.set([item(), item({ id: "item-2", title: "Which region?" })]);
  e.polls[0]?.answer(["inbox.opened"]);
  expect(
    await screen.findByRole("img", { name: "2 items need you" }),
  ).toBeVisible();

  await waitFor(() => expect(e.polls).toHaveLength(2));
  expect(e.polls[1]?.after).toBe(900_001n);
  e.set([item()]);
  e.polls[1]?.answer(["inbox.resolved"]);
  expect(
    await screen.findByRole("img", { name: "1 item needs you" }),
  ).toBeVisible();
});

it("reads the list again for an inbox event only, not for a card event", async () => {
  const e = views([item()]);
  await screen.findByRole("img", { name: "1 item needs you" });
  await waitFor(() => expect(e.polls).toHaveLength(1));
  e.polls[0]?.answer(["card.state", "activity.added"]);
  await waitFor(() => expect(e.polls).toHaveLength(2));
  expect(e.calls.listInbox).toHaveBeenCalledTimes(1);
});

it("answers from the list and reads it again, so the item leaves at once", async () => {
  const user = userEvent.setup();
  const e = views([item(), item({ id: "item-2", title: "Which region?" })]);
  await user.click(await screen.findByRole("tab", { name: /Needs you/ }));
  const list = await screen.findByRole("list", { name: "Needs you" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  await user.click(
    within(list).getAllByRole("button", { name: "Approve" })[0] as HTMLElement,
  );
  expect(e.calls.answerInbox).toHaveBeenCalledWith("item-1", "approve", "");
  await waitFor(() =>
    expect(within(list).getAllByRole("listitem")).toHaveLength(1),
  );
  expect(screen.getByRole("img", { name: "1 item needs you" })).toBeVisible();
});

it("says so when nothing waits", async () => {
  const user = userEvent.setup();
  views([]);
  await user.click(await screen.findByRole("tab", { name: /Needs you/ }));
  expect(await screen.findByText("Nothing needs you")).toBeVisible();
});

it("shows the failure beside the list and reads again on Retry", async () => {
  const user = userEvent.setup();
  views([], { failFirst: "Beehive is not reachable" });
  await user.click(await screen.findByRole("tab", { name: /Needs you/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  expect(screen.queryByText("Nothing needs you")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Nothing needs you")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});
