// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { BeehiveViews } from "./BeehiveViews";
import type { Client } from "./engine/client";
import { useInbox } from "./engine/useInbox";
import { EngineError } from "./engine/transport";
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
    fail(error: unknown): void;
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
        new Promise((resolve, reject) =>
          // The board's poll is parked for good; only the inbox's can be answered.
          after < 900_000n
            ? undefined
            : polls.push({
                after,
                signal,
                fail: reject,
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
      me=""
      onLeaveCard={vi.fn()}
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
  await user.click(await screen.findByRole("button", { name: /Needs you/ }));
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

it("titles the page with how many wait, and lists the oldest first", async () => {
  const user = userEvent.setup();
  views([
    item({
      id: "new",
      cardTitle: "Newer card",
      createdAt: { seconds: 200n, nanos: 0 },
    }),
    item({
      id: "old",
      cardTitle: "Older card",
      createdAt: { seconds: 100n, nanos: 0 },
    }),
  ]);
  await user.click(await screen.findByRole("button", { name: /Needs you/ }));
  expect(
    await screen.findByRole("heading", { name: "Needs you" }),
  ).toBeVisible();
  expect(screen.getByText("2 waiting. Oldest first.")).toBeVisible();
  const list = await screen.findByRole("list", { name: "Needs you" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((entry) => entry.textContent),
  ).toEqual([
    expect.stringContaining("Older card"),
    expect.stringContaining("Newer card"),
  ]);
});

it("says so when nothing waits", async () => {
  const user = userEvent.setup();
  views([]);
  await user.click(await screen.findByRole("button", { name: /Needs you/ }));
  expect(await screen.findByText("Nothing needs you")).toBeVisible();
});

it("shows the failure beside the list and reads again on Retry", async () => {
  const user = userEvent.setup();
  views([], { failFirst: "Beehive is not reachable" });
  await user.click(await screen.findByRole("button", { name: /Needs you/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  expect(screen.queryByText("Nothing needs you")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Nothing needs you")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

/** A promise the test settles by hand. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("shows the engine's refusal of an answer without a dialog and lets the person try again", async () => {
  const user = userEvent.setup();
  const { onAnswer } = card({
    onAnswer: async () => {
      throw new Error("someone else already answered this item");
    },
  });
  await user.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "someone else already answered",
  );
  expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
});

it("keeps the Stop run question open with the engine's refusal in it", async () => {
  const user = userEvent.setup();
  card({
    item: item({ kind: "route", detailJson: "{}", choices: ["skip", "stop"] }),
    onAnswer: async () => {
      throw new Error("the run already ended");
    },
  });
  await user.click(screen.getByRole("button", { name: "Stop run" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Stop run" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "the run already ended",
  );
  expect(screen.getByRole("alertdialog")).toBeVisible();
});

it("ignores a second press while an answer is on its way", async () => {
  const user = userEvent.setup();
  const held = gate();
  const { onAnswer } = card({ onAnswer: () => held.promise });
  await user.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Approve" }));
  expect(onAnswer).toHaveBeenCalledTimes(1);
  held.release();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(),
  );
});

it("clears the words and the refusal when the reason is cancelled", async () => {
  const user = userEvent.setup();
  card({
    onAnswer: async () => {
      throw new Error("the item is out of date");
    },
  });
  await user.click(screen.getByRole("button", { name: "Reject" }));
  let dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByRole("textbox"), "Not yet.");
  await user.click(within(dialog).getByRole("button", { name: "Reject" }));
  await within(dialog).findByRole("alert");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Reject" }));
  dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("textbox")).toHaveValue("");
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

it("sends Retry and Dismiss for a failure with no words, and names a choice it does not know as the engine did", async () => {
  const user = userEvent.setup();
  const { onAnswer } = card({
    item: item({
      kind: "failure",
      title: "The stage failed",
      detailJson: "{}",
      choices: ["retry", "dismiss", "escalate"],
    }),
  });
  expect(
    screen.getByRole("region", { name: "Failed: Write the docs" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(onAnswer).toHaveBeenLastCalledWith(expect.anything(), "retry", "");
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onAnswer).toHaveBeenLastCalledWith(expect.anything(), "dismiss", "");
  await user.click(screen.getByRole("button", { name: "escalate" }));
  expect(onAnswer).toHaveBeenLastCalledWith(expect.anything(), "escalate", "");
});

it("words a kind it does not know", () => {
  card({ item: item({ kind: "needs_review", choices: [] }) });
  expect(
    screen.getByRole("region", { name: "needs review: Write the docs" }),
  ).toBeVisible();
});

it("says live updates paused when the poll is refused, and keeps the list", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const user = userEvent.setup();
  const e = views([item()]);
  await screen.findByRole("img", { name: "1 item needs you" });
  await waitFor(() => expect(e.polls).toHaveLength(1));
  e.polls[0]?.fail(
    new EngineError("permission_denied", "your access changed", 403),
  );
  await user.click(await screen.findByRole("button", { name: /Needs you/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Live updates paused: your access changed",
  );
  expect(screen.getByRole("list", { name: "Needs you" })).toBeVisible();
  // The tab says the count may be out of date, beside the count.
  expect(
    screen.getByRole("img", { name: "What needs you could not be checked" }),
  ).toBeVisible();
  expect(screen.getByRole("img", { name: "1 item needs you" })).toBeVisible();
  warn.mockRestore();
});

it("pauses after three failures in a row and clears the notice when a poll succeeds", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const user = userEvent.setup();
  const e = views([item()]);
  await screen.findByRole("img", { name: "1 item needs you" });
  await user.click(await screen.findByRole("button", { name: /Needs you/ }));
  for (let failure = 1; failure <= 3; failure += 1) {
    await waitFor(() => expect(e.polls).toHaveLength(failure));
    expect(screen.queryByRole("alert")).toBeNull();
    e.polls[failure - 1]?.fail(new Error("Beehive is not reachable"));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Live updates paused: Beehive is not reachable",
  );
  await waitFor(() => expect(e.polls).toHaveLength(4));
  e.polls[3]?.answer(["card.state"]);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  random.mockRestore();
  warn.mockRestore();
});

it("keeps the list and says the read failed when reading it again fails", async () => {
  const user = userEvent.setup();
  const e = views([item()]);
  await user.click(await screen.findByRole("button", { name: /Needs you/ }));
  await screen.findByRole("list", { name: "Needs you" });
  await waitFor(() => expect(e.polls).toHaveLength(1));
  e.calls.listInbox.mockRejectedValueOnce(
    new Error("Beehive is not reachable"),
  );
  e.polls[0]?.answer(["inbox.opened"]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  expect(screen.getByRole("list", { name: "Needs you" })).toBeVisible();
});

it("marks the tab when the first read failed, so no count is not read as nothing waiting", async () => {
  views([], { failFirst: "Beehive is not reachable" });
  expect(
    await screen.findByRole("img", {
      name: "What needs you could not be checked",
    }),
  ).toBeVisible();
  expect(screen.queryByRole("img", { name: /items? needs? you/ })).toBeNull();
});

it("collapses reads asked for while one is out into one more", async () => {
  const held = gate();
  const listInbox = vi.fn(async () => {
    if (listInbox.mock.calls.length === 1) await held.promise;
    return create(ListInboxResponseSchema, { items: [], seq: 900_000n });
  });
  const client = {
    listInbox,
    pollEvents: vi.fn(() => new Promise(() => undefined)),
  } as unknown as Client;
  const { result } = renderHook(() => useInbox(client));
  await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));
  act(() => {
    result.current.refresh();
    result.current.refresh();
  });
  expect(listInbox).toHaveBeenCalledTimes(1);
  await act(async () => held.release());
  await waitFor(() => expect(result.current.inbox.status).toBe("ready"));
  expect(listInbox).toHaveBeenCalledTimes(2);
});
