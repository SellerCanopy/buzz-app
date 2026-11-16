// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { BeehivePage } from "./BeehivePage";
import { fakeRelay } from "./fake-relay";
import type { Client } from "./engine/client";
import { EngineError } from "./engine/transport";
import {
  AccessEntrySchema,
  ArtifactInfoSchema,
  ArtifactVersionSchema,
  CardSchema,
  EventSchema,
  CheckWorkflowResponseSchema,
  ListAccessResponseSchema,
  ListArtifactsResponseSchema,
  ListArtifactVersionsResponseSchema,
  ListCardsResponseSchema,
  ListInboxResponseSchema,
  ListRunsResponseSchema,
  ListWorkflowsResponseSchema,
  GetSettingsResponseSchema,
  GetStatusResponseSchema,
  RunSchema,
  RunStepSchema,
  SettingSchema,
  StageThreadSchema,
  PollEventsResponseSchema,
  WhoAmIResponseSchema,
  type AccessEntry,
  type ArtifactVersion,
  type Card,
  type Run,
} from "./gen/kiln/engine/v1/engine_pb";
import { createLevelStore, type LevelStore } from "./level";
import { PAGE_ID, PLUGIN_ID } from "./routes";

afterEach(cleanup);

const ID = "0b8f4d1e-6c1f-4f0e-9d53-2f3f6a0a1c11";
/**
 * The page also follows the inbox for the Needs you count. Its read returns this sequence
 * number, far past the board's, so its parked poll is told apart and kept out of `polls`.
 */
const INBOX_SEQ = 900_000n;
const card = (fields: MessageInitShape<typeof CardSchema> = {}) =>
  create(CardSchema, { id: ID, title: "Fix the build", ...fields });

/** A Beehive with a parked long poll the test can answer. */
function engine(
  options: {
    cards?: Card[];
    /** The card's runs, newest first. */
    runs?: Run[];
    role?: string;
    seq?: bigint;
    /** The channel id the update_channel setting holds, or none. */
    updateChannel?: string;
    /** Who the access list shows, each with the level they act at. */
    access?: AccessEntry[];
    /** What the card's stages saved, every version of each, oldest first. */
    saved?: ArtifactVersion[];
  } = {},
) {
  const polls: {
    after: bigint;
    signal: AbortSignal | undefined;
    answer(events: Card[], type: string): void;
  }[] = [];
  const client = {
    listCards: vi.fn(async (archived = false) =>
      create(ListCardsResponseSchema, {
        cards: (options.cards ?? []).filter((c) => c.archived === archived),
        seq: options.seq ?? 5n,
      }),
    ),
    listInbox: vi.fn(async () =>
      create(ListInboxResponseSchema, { items: [], seq: INBOX_SEQ }),
    ),
    whoAmI: vi.fn(async () =>
      create(WhoAmIResponseSchema, { role: options.role ?? "run" }),
    ),
    // The level store follows the log from here, which is where the inbox follows from.
    getStatus: vi.fn(async () =>
      create(GetStatusResponseSchema, { headSeq: INBOX_SEQ }),
    ),
    listWorkflows: vi.fn(async () =>
      create(ListWorkflowsResponseSchema, {
        workflows: [{ name: "demo", ok: true, builtin: true }],
      }),
    ),
    checkWorkflow: vi.fn(async () => create(CheckWorkflowResponseSchema, {})),
    getCard: vi.fn(async () => card({ body: "Line one\nLine two" })),
    createCard: vi.fn(async () => card()),
    startRun: vi.fn(async () => create(RunSchema, { id: "run-1", cardId: ID })),
    listRuns: vi.fn(async () =>
      create(ListRunsResponseSchema, { runs: options.runs ?? [] }),
    ),
    listArtifacts: vi.fn(async () => {
      const names = [...new Set((options.saved ?? []).map((v) => v.name))];
      return create(ListArtifactsResponseSchema, {
        artifacts: names.map((name) => {
          const all = (options.saved ?? []).filter((v) => v.name === name);
          const last = all[all.length - 1] as ArtifactVersion;
          return create(ArtifactInfoSchema, {
            name,
            latest: last.version,
            kind: last.kind,
          });
        }),
      });
    }),
    listArtifactVersions: vi.fn(async (_card: string, name: string) =>
      create(ListArtifactVersionsResponseSchema, {
        versions: (options.saved ?? [])
          .filter((v) => v.name === name)
          .map((v) => ({ ...v, content: "" })),
      }),
    ),
    readArtifact: vi.fn(async (_card: string, name: string, version = 0) => {
      const all = (options.saved ?? []).filter((v) => v.name === name);
      return (all.find((v) => v.version === version) ??
        all[all.length - 1]) as ArtifactVersion;
    }),
    resumeCard: vi.fn(async () =>
      create(RunSchema, { id: "run-1", cardId: ID, state: "running" }),
    ),
    stopRun: vi.fn(async () =>
      create(RunSchema, { id: "run-1", cardId: ID, state: "ended" }),
    ),
    retryRun: vi.fn(async () =>
      create(RunSchema, { id: "run-2", cardId: ID, state: "running" }),
    ),
    getCommunitySettings: vi.fn(async () =>
      create(GetSettingsResponseSchema, {
        settings: [
          create(SettingSchema, {
            key: "update_channel",
            valueJson: options.updateChannel
              ? JSON.stringify(options.updateChannel)
              : "null",
          }),
        ],
      }),
    ),
    listAccess: vi.fn(async () =>
      create(ListAccessResponseSchema, { entries: options.access ?? [] }),
    ),
    setAccessLevel: vi.fn(async (pubkey: string, level: string) => {
      const entry = (options.access ?? []).find((e) => e.pubkey === pubkey);
      if (entry) entry.level = level;
      return create(AccessEntrySchema, { pubkey, level });
    }),
    setCommunitySetting: vi.fn(async (key: string, valueJson: string) =>
      create(SettingSchema, { key, valueJson }),
    ),
    archiveCards: vi.fn(async () => ({})),
    restoreCard: vi.fn(async () => card()),
    mergeCard: vi.fn(async () => card()),
    setAutoMode: vi.fn(async () => card({ autoMode: true })),
    pollEvents: vi.fn(
      (after: bigint, _wait?: number, signal?: AbortSignal) =>
        new Promise((resolve) =>
          (after >= INBOX_SEQ ? [] : polls).push({
            after,
            signal,
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

/**
 * Resolves once the engine's answer to WhoAmI has gone through the level store and into the
 * page. Until then nothing is offered, so a control that is absent proves nothing. The store
 * awaited the same promise first, so its continuation, which applies the level, runs before
 * this one resumes.
 */
async function levelApplied(e: { calls: { whoAmI: Mock } }) {
  await vi.waitFor(() => expect(e.calls.whoAmI).toHaveBeenCalled());
  await act(async () => {
    await Promise.all(e.calls.whoAmI.mock.results.map((r) => r.value));
  });
}

const CHANNEL = "5f1c2d3e-0000-4000-8000-000000000001";
const OTHER = "5f1c2d3e-0000-4000-8000-000000000002";
const channels = fakeRelay([
  { id: CHANNEL, name: "updates" },
  { id: OTHER, name: "general" },
  { id: "dm-1", name: "A direct message", channelType: "dm" },
]);

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

/** A navigator that follows the visit it opens, as the shell does; its calls are recorded. */
function shell(target: OpenTarget = board) {
  const mock = { open: vi.fn(), dismiss: vi.fn() };
  const signal = new AbortController().signal;
  const Host = ({ children }: { children(props: object): ReactElement }) => {
    const [current, setCurrent] = useState(target);
    mock.open.mockImplementation(async (next: OpenTarget) => {
      setCurrent(next);
      return {};
    });
    return children({
      navigator: mock as unknown as Navigation,
      navigation: { entryId: "visit-1", target: current, signal } as never,
    });
  };
  return { mock, Host };
}

/** The host's embedded thread, reduced to what the page hands it. */
const Thread = (props: { channelId: string; messageId: string }) => (
  <div data-testid="thread" data-channel={props.channelId}>
    {props.messageId}
  </div>
);

function page(
  client: Client,
  target?: OpenTarget,
  relay = fakeRelay([]),
  level?: LevelStore,
) {
  const s = shell(target);
  render(
    <s.Host>
      {(props) => (
        <BeehivePage
          client={client}
          relay={relay}
          level={level}
          Thread={Thread as never}
          {...props}
        />
      )}
    </s.Host>,
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

it("places a card in the column its state names", async () => {
  page(
    engine({
      cards: [
        // No workflow means Backlog whatever the state says.
        card({ id: "a", title: "Loose", state: "running" }),
        card({ id: "b", title: "Ready", workflow: "w", state: "idle" }),
        card({ id: "c", title: "Going", workflow: "w", state: "running" }),
        card({ id: "d", title: "Held", workflow: "w", state: "waiting" }),
        card({ id: "e", title: "Broke", workflow: "w", state: "failed" }),
        card({ id: "f", title: "Halted", workflow: "w", state: "stopped" }),
        card({ id: "g", title: "Shipped", workflow: "w", state: "done" }),
        card({ id: "h", title: "Odd", workflow: "w", state: "unheard-of" }),
      ],
    }).client,
  );
  await screen.findByText("Loose");
  const expected: [string, string[]][] = [
    ["Backlog", ["Loose"]],
    ["To do", ["Ready", "Odd"]],
    ["Running", ["Going"]],
    ["Waiting", ["Held"]],
    ["Needs attention", ["Broke", "Halted"]],
    ["Done", ["Shipped"]],
  ];
  for (const [name, titles] of expected) {
    const region = screen.getByRole("region", { name });
    expect(
      within(region)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(titles.map((title) => expect.stringContaining(title)));
  }
});

it("says nothing is archived and offers no way to add a card there", async () => {
  page(engine().client);
  await screen.findByText("No cards yet");
  // The header's button and the empty state's own.
  expect(screen.getAllByRole("button", { name: "New card" })).toHaveLength(2);
  await userEvent.click(screen.getByRole("tab", { name: "Archive" }));
  expect(await screen.findByText("Nothing archived")).toBeVisible();
  expect(
    screen.getByText("Cards you archive are kept here and can be restored."),
  ).toBeVisible();
  expect(screen.getAllByRole("button", { name: "New card" })).toHaveLength(1);
});

it("says so when what the person may do cannot be read, and Retry asks again", async () => {
  const e = engine({ role: "run" });
  e.calls.whoAmI.mockRejectedValueOnce(new Error("Beehive is not reachable"));
  page(e.client);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not check what you can do. Beehive is not reachable",
  );
  // Not knowing is not the same as being allowed: no controls until it answers.
  expect(screen.queryByRole("button", { name: "New card" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    (await screen.findAllByRole("button", { name: "New card" })).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(e.calls.whoAmI).toHaveBeenCalledTimes(2);
});

it("reads what the person may do from the host's level store and starts no second one", async () => {
  const e = engine({ role: "read" });
  const level = createLevelStore(e.client);
  const stop = level.start();
  await vi.waitFor(() => expect(level.get().status).toBe("ready"));
  page(e.client, undefined, fakeRelay([]), level);
  await screen.findByText("No cards yet");
  // The store's own read is the only one, and it already holds Read.
  expect(e.calls.whoAmI).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "New card" })).toBeNull();

  // A level the store takes later reaches the page's controls.
  e.calls.whoAmI.mockResolvedValue(
    create(WhoAmIResponseSchema, { role: "run" }),
  );
  act(() => level.refresh());
  expect(
    (await screen.findAllByRole("button", { name: "New card" })).length,
  ).toBeGreaterThan(0);
  expect(e.calls.whoAmI).toHaveBeenCalledTimes(2);
  stop();
});

it("shows the host's store failing to read the level, and Retry asks that store again", async () => {
  const e = engine({ role: "run" });
  e.calls.whoAmI.mockRejectedValueOnce(new Error("Beehive is not reachable"));
  const level = createLevelStore(e.client);
  const refresh = vi.spyOn(level, "refresh");
  const stop = level.start();
  await vi.waitFor(() => expect(level.get().status).toBe("error"));
  page(e.client, undefined, fakeRelay([]), level);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not check what you can do. Beehive is not reachable",
  );
  expect(screen.queryByRole("button", { name: "New card" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(
    (await screen.findAllByRole("button", { name: "New card" })).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(e.calls.whoAmI).toHaveBeenCalledTimes(2);
  stop();
});

it("keeps the cards and says live updates paused when the poll is refused, and Retry reads again", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const e = engine({ cards: [card()] });
  e.calls.pollEvents.mockRejectedValue(
    new EngineError("permission_denied", "your access changed", 403),
  );
  page(e.client);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Live updates paused: your access changed",
  );
  expect(screen.getByText("Fix the build")).toBeVisible();
  expect(warn).toHaveBeenCalledWith(
    "Beehive live updates failed",
    expect.objectContaining({ code: "permission_denied", terminal: true }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(e.calls.listCards).toHaveBeenCalledTimes(2));
  warn.mockRestore();
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
  // Workflows keeps no poll open for a board nobody is looking at.
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  expect(e.polls[0]?.signal?.aborted).toBe(true);
  await userEvent.click(screen.getByRole("tab", { name: "Board" }));
  expect(await screen.findByText("Fix the build")).toBeVisible();
  // The board reads again on return and follows the log from the new read.
  expect(e.calls.listCards).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(e.polls).toHaveLength(2));
  expect(e.polls[1]?.signal?.aborted).toBe(false);
});

it("offers New card only to someone who can run", async () => {
  const reader = engine({ role: "read" });
  page(reader.client);
  await screen.findByText("No cards yet");
  await levelApplied(reader);
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

const ROOT = "ab".repeat(32);

it("opens a card on its Live tab when a stage has a thread, and a tab choice is a visit", async () => {
  const e = engine({
    runs: [run({ state: "running", steps: [step({ stage: "build" })] })],
  });
  e.calls.getCard.mockResolvedValue(
    card({
      workflow: "demo",
      state: "running",
      stageId: "build",
      stages: [
        create(StageThreadSchema, {
          stage: "build",
          visit: 1,
          rootEventId: ROOT,
          channelId: CHANNEL,
        }),
      ],
    }),
  );
  const nav = page(e.client, cardView, channels);
  expect(await screen.findByTestId("thread")).toHaveTextContent(ROOT);
  expect(screen.getByRole("tab", { name: "Live" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await userEvent.click(screen.getByRole("tab", { name: "Steps" }));
  expect(nav.open).toHaveBeenCalledWith({
    ...board,
    route: { version: 1, params: { card: ID, tab: "steps" } },
  });
});

it("shows the tab a visit names", async () => {
  const e = engine({
    runs: [run({ state: "running", steps: [step({ stage: "build" })] })],
  });
  e.calls.getCard.mockResolvedValue(card({ workflow: "demo" }));
  page(e.client, {
    ...board,
    route: { version: 1, params: { card: ID, tab: "steps" } },
  } as OpenTarget);
  expect(
    await screen.findByRole("list", { name: "Stages of the run" }),
  ).toBeVisible();
});

it("has no Live tab for a card that never ran", async () => {
  page(engine().client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  expect(screen.queryByRole("tab", { name: "Live" })).toBeNull();
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

it("starts a run on an idle card with a workflow and reads the card again", async () => {
  const e = engine();
  e.calls.getCard.mockResolvedValue(card({ workflow: "demo", state: "idle" }));
  page(e.client, cardView);
  await userEvent.click(
    await screen.findByRole("button", { name: "Start run" }),
  );
  await vi.waitFor(() => expect(e.calls.startRun).toHaveBeenCalledWith(ID));
  await vi.waitFor(() => expect(e.calls.getCard).toHaveBeenCalledTimes(2));
});

it("shows the engine's refusal to start a run word for word", async () => {
  const e = engine();
  e.calls.getCard.mockResolvedValue(card({ workflow: "demo", state: "idle" }));
  e.calls.startRun.mockRejectedValue(
    new Error(
      "choose an update channel in Beehive settings before starting a run",
    ),
  );
  page(e.client, cardView);
  await userEvent.click(
    await screen.findByRole("button", { name: "Start run" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "choose an update channel in Beehive settings before starting a run",
  );
});

it("offers Start run only to a person who can run, on a card that can start", async () => {
  const backlog = engine();
  page(backlog.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  await levelApplied(backlog);
  expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
  cleanup();

  const running = engine();
  running.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "running" }),
  );
  page(running.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  await levelApplied(running);
  expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
  cleanup();

  const reader = engine({ role: "read" });
  reader.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "idle" }),
  );
  page(reader.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  await levelApplied(reader);
  expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
});

it("offers Archive and Restore only to a person who can run", async () => {
  const runner = engine();
  page(runner.client, cardView);
  expect(await screen.findByRole("button", { name: "Archive" })).toBeVisible();
  cleanup();

  const reader = engine({ role: "read" });
  page(reader.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  await levelApplied(reader);
  expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  cleanup();

  const archived = engine({ role: "read" });
  archived.calls.getCard.mockResolvedValue(card({ archived: true }));
  page(archived.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  await levelApplied(archived);
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
});

const openPull = (fields: Record<string, unknown> = {}) => ({
  number: 12,
  url: "https://github.example.org/example-org/api/pull/12",
  state: "open",
  draft: false,
  checks: "passing",
  ...fields,
});

it("merges the card's pull request and reads the card again", async () => {
  const e = engine();
  e.calls.getCard.mockResolvedValue(card({ pullRequest: openPull() }));
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("button", { name: "Merge" }));
  await vi.waitFor(() => expect(e.calls.mergeCard).toHaveBeenCalledWith(ID));
  await vi.waitFor(() => expect(e.calls.getCard).toHaveBeenCalledTimes(2));
});

it("offers Merge only to a person who can run, for a pull request that can be merged", async () => {
  const reader = engine({ role: "read" });
  reader.calls.getCard.mockResolvedValue(card({ pullRequest: openPull() }));
  page(reader.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  await levelApplied(reader);
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  cleanup();

  for (const pull of [
    openPull({ draft: true }),
    openPull({ checks: "failing" }),
    openPull({ checks: "pending" }),
    openPull({ state: "merged" }),
    openPull({ state: "closed" }),
  ]) {
    const e = engine();
    e.calls.getCard.mockResolvedValue(card({ pullRequest: pull }));
    page(e.client, cardView);
    await screen.findByRole("tab", { name: "Details" });
    await levelApplied(e);
    await screen.findByRole("button", { name: "Archive" });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    cleanup();
  }

  const none = engine();
  page(none.client, cardView);
  await screen.findByRole("button", { name: "Archive" });
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
});

it("shows the engine's refusal to merge", async () => {
  const e = engine();
  e.calls.getCard.mockResolvedValue(card({ pullRequest: openPull() }));
  e.calls.mergeCard.mockRejectedValueOnce(
    new Error("the pull request has failing checks"),
  );
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("button", { name: "Merge" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the pull request has failing checks",
  );
});

it("shows what a wait stage is waiting for on the Steps tab", async () => {
  const e = engine({
    runs: [
      run({
        state: "running",
        steps: [
          step({
            stage: "validate",
            summary: "waiting for the checks build, lint to pass",
          }),
        ],
      }),
    ],
  });
  e.calls.getCard.mockResolvedValue(card({ workflow: "demo" }));
  page(e.client, {
    ...board,
    route: { version: 1, params: { card: ID, tab: "steps" } },
  } as OpenTarget);
  expect(
    await screen.findByText("waiting for the checks build, lint to pass"),
  ).toBeVisible();
});

it("shows the engine's refusal to archive and lets the person try again", async () => {
  const e = engine();
  e.calls.archiveCards.mockRejectedValueOnce(new Error("the card is running"));
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the card is running",
  );
  const again = screen.getByRole("button", { name: "Archive" });
  expect(again).toBeEnabled();
  await userEvent.click(again);
  await vi.waitFor(() => expect(e.calls.archiveCards).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("ignores a second click while an action is running", async () => {
  const e = engine();
  let finish: () => void = () => {};
  e.calls.archiveCards.mockImplementationOnce(
    () => new Promise((resolve) => (finish = () => resolve({}))),
  );
  page(e.client, cardView);
  const archive = await screen.findByRole("button", { name: "Archive" });
  await userEvent.click(archive);
  await vi.waitFor(() => expect(archive).toBeDisabled());
  await userEvent.click(archive);
  expect(e.calls.archiveCards).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(e.calls.getCard).toHaveBeenCalledTimes(2));
});

it("does not offer Start run on an archived card that has a workflow", async () => {
  const e = engine();
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "idle", archived: true }),
  );
  page(e.client, cardView);
  expect(await screen.findByRole("button", { name: "Restore" })).toBeVisible();
  await levelApplied(e);
  expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
});

it("reads the card again when Retry is pressed after a failed read", async () => {
  const e = engine();
  e.calls.getCard.mockRejectedValueOnce(new Error("Beehive is not reachable"));
  page(e.client, cardView);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/Line one/)).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(e.calls.getCard).toHaveBeenCalledTimes(2);
});

it("opens Details when the visit names a tab the card does not have", async () => {
  page(engine().client, {
    ...board,
    route: { version: 1, params: { card: ID, tab: "live" } },
  } as OpenTarget);
  expect(await screen.findByRole("tab", { name: "Details" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByRole("tab", { name: "Live" })).toBeNull();
});

it("says the card may be out of date when reading it again fails after an action", async () => {
  const e = engine();
  e.calls.getCard
    .mockResolvedValueOnce(card({ workflow: "demo", state: "idle" }))
    .mockRejectedValueOnce(new Error("Beehive is not reachable"));
  page(e.client, cardView);
  await userEvent.click(
    await screen.findByRole("button", { name: "Start run" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The card may be out of date. Beehive is not reachable",
  );
  // The card stays on screen, and Retry reads it again.
  expect(screen.getByRole("tab", { name: "Details" })).toBeVisible();
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "running" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
});

const step = (fields: MessageInitShape<typeof RunStepSchema>) =>
  create(RunStepSchema, { visit: 1, round: 1, ...fields });
const run = (fields: MessageInitShape<typeof RunSchema> = {}) =>
  create(RunSchema, { id: "run-1", cardId: ID, ...fields });

it("lists the stages of the card's run with where each stands", async () => {
  const e = engine({
    runs: [
      run({
        state: "running",
        stageId: "review",
        steps: [
          step({
            stage: "build",
            result: "passed",
            routedTo: "review",
            summary: "built it",
          }),
          step({ stage: "review", round: 2, result: "needs_work" }),
        ],
      }),
    ],
  });
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "running" }),
  );
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("tab", { name: "Steps" }));
  const stages = await screen.findByRole("list", { name: "Stages of the run" });
  const [first, second] = within(stages).getAllByRole("listitem");
  expect(first).toHaveTextContent("build");
  expect(first).toHaveTextContent("passed, then review");
  expect(first).toHaveTextContent("built it");
  expect(second).toHaveTextContent("review");
  expect(second).toHaveTextContent("Running, round 2, last result needs work");
});

it("marks a stage that was skipped, and one that is held", async () => {
  const e = engine({
    runs: [
      run({
        state: "paused",
        stageId: "ship",
        steps: [
          step({ stage: "lint", skipped: true }),
          step({ stage: "ship", held: true }),
        ],
      }),
    ],
  });
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "waiting" }),
  );
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("tab", { name: "Steps" }));
  const [first, second] = within(
    await screen.findByRole("list", { name: "Stages of the run" }),
  ).getAllByRole("listitem");
  expect(first).toHaveTextContent("Skipped");
  expect(second).toHaveTextContent("Held until someone resumes it");
});

it("has no Steps tab for a card that never ran", async () => {
  page(engine().client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  expect(screen.queryByRole("tab", { name: "Steps" })).toBeNull();
});

const saved = (fields: MessageInitShape<typeof ArtifactVersionSchema>) =>
  create(ArtifactVersionSchema, { kind: "text", version: 1, ...fields });

/** A card that ran, with what its stages saved. */
function withFiles(versions: ArtifactVersion[], relay = fakeRelay([])) {
  const e = engine({
    runs: [run({ state: "running", steps: [step({ stage: "build" })] })],
    saved: versions,
  });
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "running" }),
  );
  page(e.client, cardView, relay);
  return e;
}

it("shows a document's text and every version of it in the Files tab", async () => {
  const e = withFiles([
    saved({ name: "plan", version: 1, content: "First draft" }),
    saved({ name: "plan", version: 2, content: "Second draft" }),
  ]);
  await userEvent.click(await screen.findByRole("tab", { name: "Files" }));
  expect(await screen.findByLabelText("plan")).toHaveTextContent(
    "Second draft",
  );
  expect(e.calls.readArtifact).toHaveBeenCalledWith(
    ID,
    "plan",
    2,
    expect.anything(),
  );
  await userEvent.click(screen.getByRole("combobox", { name: /Version/ }));
  await userEvent.click(await screen.findByRole("option", { name: "1" }));
  expect(await screen.findByLabelText("plan")).toHaveTextContent("First draft");
});

it("shows a file's type and size with a link to download it", async () => {
  withFiles([
    saved({
      name: "picture",
      kind: "file",
      mediaType: "image/png",
      size: 2048n,
      mediaRef: "https://relay.example.org/media/abc.png",
    }),
  ]);
  await userEvent.click(await screen.findByRole("tab", { name: "Files" }));
  expect(await screen.findByText("image/png · 2 KB")).toBeVisible();
  expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    "https://relay.example.org/media/abc.png",
  );
});

it("names the command that fetches a file the app cannot open", async () => {
  const relay = fakeRelay([]);
  const ready = relay.snapshot();
  (ready.session as unknown as { media(url: string): undefined }).media = () =>
    undefined;
  withFiles(
    [
      saved({
        name: "picture",
        kind: "file",
        mediaType: "image/png",
        size: 10n,
        mediaRef: "https://relay.example.org/media/abc.png",
      }),
    ],
    relay,
  );
  await userEvent.click(await screen.findByRole("tab", { name: "Files" }));
  expect(await screen.findByText(/buzz media get/)).toHaveTextContent(
    "https://relay.example.org/media/abc.png",
  );
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
});

it("says so when a card has saved nothing, and shows a failure with a retry", async () => {
  const e = withFiles([]);
  e.calls.listArtifacts.mockRejectedValueOnce(new Error("Beehive is down"));
  await userEvent.click(await screen.findByRole("tab", { name: "Files" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Beehive is down");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No files yet")).toBeVisible();
});

it("has no Files tab for a card that never ran", async () => {
  page(engine().client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
});

it("keeps the version a person chose when reading it again after a failure", async () => {
  const e = withFiles([
    saved({ name: "plan", version: 1, content: "First draft" }),
    saved({ name: "plan", version: 2, content: "Second draft" }),
    saved({ name: "plan", version: 3, content: "Third draft" }),
  ]);
  const read = e.calls.readArtifact.getMockImplementation() as (
    card: string,
    name: string,
    version?: number,
  ) => Promise<ArtifactVersion>;
  let failFirst = true;
  e.calls.readArtifact.mockImplementation(async (c, n, v) => {
    if (v === 1 && failFirst) {
      failFirst = false;
      throw new Error("Beehive is not reachable");
    }
    return read(c, n, v);
  });
  await userEvent.click(await screen.findByRole("tab", { name: "Files" }));
  expect(await screen.findByLabelText("plan")).toHaveTextContent("Third draft");
  await userEvent.click(screen.getByRole("combobox", { name: /Version/ }));
  await userEvent.click(await screen.findByRole("option", { name: "1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByLabelText("plan")).toHaveTextContent("First draft");
  expect(screen.getByRole("combobox", { name: /Version/ })).toHaveTextContent(
    "1",
  );
  expect(screen.queryByText("Third draft")).toBeNull();
});

it("resumes a held card and reads it again", async () => {
  const e = engine({
    runs: [
      run({
        state: "paused",
        stageId: "ship",
        steps: [step({ stage: "ship", held: true })],
      }),
    ],
  });
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "waiting" }),
  );
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await vi.waitFor(() => expect(e.calls.resumeCard).toHaveBeenCalledWith(ID));
  await vi.waitFor(() => expect(e.calls.getCard).toHaveBeenCalledTimes(2));
});

it("offers Resume only to a person who can run, on a held card", async () => {
  const held = [run({ state: "paused", steps: [step({ stage: "ship" })] })];
  const reader = engine({ role: "read", runs: held });
  reader.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "waiting" }),
  );
  page(reader.client, cardView);
  await screen.findByRole("tab", { name: "Steps" });
  await levelApplied(reader);
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  cleanup();

  const running = engine({
    runs: [run({ state: "running", steps: [step({ stage: "ship" })] })],
  });
  running.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "running" }),
  );
  page(running.client, cardView);
  await screen.findByRole("tab", { name: "Steps" });
  await levelApplied(running);
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
});

it("shows the engine's refusal to resume word for word", async () => {
  const e = engine({
    runs: [run({ state: "paused", steps: [step({ stage: "ship" })] })],
  });
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "waiting" }),
  );
  e.calls.resumeCard.mockRejectedValue(
    new Error("the run is running; only a paused card can be resumed"),
  );
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("button", { name: "Resume" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "only a paused card can be resumed",
  );
});

it("asks before stopping a run, and stops it only when confirmed", async () => {
  const e = engine({
    runs: [run({ state: "running", steps: [step({ stage: "build" })] })],
  });
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "running" }),
  );
  page(e.client, cardView);
  await userEvent.click(
    await screen.findByRole("button", { name: "Stop run" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("Stop this run?");
  // Cancel is where focus starts, so Enter does not stop the run.
  await vi.waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(e.calls.stopRun).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
  const again = await screen.findByRole("alertdialog");
  await userEvent.click(
    within(again).getByRole("button", { name: "Stop run" }),
  );
  await vi.waitFor(() => expect(e.calls.stopRun).toHaveBeenCalledWith("run-1"));
  await vi.waitFor(() => expect(e.calls.getCard).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("stops a held run too, and shows the engine's refusal word for word", async () => {
  const e = engine({
    runs: [run({ state: "paused", steps: [step({ stage: "ship" })] })],
  });
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "waiting" }),
  );
  e.calls.stopRun.mockRejectedValue(new Error("the run has already ended"));
  page(e.client, cardView);
  await userEvent.click(
    await screen.findByRole("button", { name: "Stop run" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Stop run" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the run has already ended",
  );
});

it("retries a failed or stopped card as a new run, and reads it again", async () => {
  for (const state of ["failed", "stopped"]) {
    const e = engine({
      runs: [
        run({
          state: "ended",
          steps: [
            step({ stage: "build", failure: "build timed out after 30m" }),
          ],
        }),
      ],
    });
    e.calls.getCard.mockResolvedValue(card({ workflow: "demo", state }));
    page(e.client, cardView);
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry run" }),
    );
    await vi.waitFor(() =>
      expect(e.calls.retryRun).toHaveBeenCalledWith("run-1"),
    );
    await vi.waitFor(() => expect(e.calls.getCard).toHaveBeenCalledTimes(2));
    // A retry needs no confirmation, and a card that is not running has nothing to stop.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    cleanup();
  }
});

it("offers Stop run and Retry run only to a person who can run, when they apply", async () => {
  const ended = [run({ state: "ended", steps: [step({ stage: "build" })] })];
  const reader = engine({ role: "read", runs: ended });
  reader.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "failed" }),
  );
  page(reader.client, cardView);
  await screen.findByRole("tab", { name: "Steps" });
  await levelApplied(reader);
  expect(screen.queryByRole("button", { name: "Retry run" })).toBeNull();
  cleanup();

  const done = engine({ runs: ended });
  done.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "done" }),
  );
  page(done.client, cardView);
  await screen.findByRole("tab", { name: "Steps" });
  await levelApplied(done);
  expect(screen.queryByRole("button", { name: "Retry run" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
  cleanup();

  const archived = engine({ runs: ended });
  archived.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "failed", archived: true }),
  );
  page(archived.client, cardView);
  await screen.findByRole("tab", { name: "Steps" });
  await levelApplied(archived);
  expect(screen.queryByRole("button", { name: "Retry run" })).toBeNull();
  cleanup();

  const running = engine({
    role: "read",
    runs: [run({ state: "running", steps: [step({ stage: "build" })] })],
  });
  running.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "running" }),
  );
  page(running.client, cardView);
  await screen.findByRole("tab", { name: "Steps" });
  await levelApplied(running);
  expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
});

it("shows why a stage failed beside the stage", async () => {
  const e = engine({
    runs: [
      run({
        state: "ended",
        steps: [step({ stage: "build", failure: "build timed out after 30m" })],
      }),
    ],
  });
  e.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "failed" }),
  );
  page(e.client, cardView);
  await userEvent.click(await screen.findByRole("tab", { name: "Steps" }));
  expect(
    within(
      await screen.findByRole("list", { name: "Stages of the run" }),
    ).getByText("build timed out after 30m"),
  ).toBeInTheDocument();
});

it("lets an admin pick the update channel in Settings", async () => {
  const e = engine({ role: "admin" });
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  const select = await screen.findByRole("combobox", {
    name: "Update channel",
  });
  expect(select).toHaveTextContent("No channel");
  await userEvent.click(select);
  // Only open stream channels are offered.
  expect(screen.queryByRole("option", { name: /direct message/ })).toBeNull();
  await userEvent.click(
    await screen.findByRole("option", { name: "# updates" }),
  );
  await vi.waitFor(() =>
    expect(e.calls.setCommunitySetting).toHaveBeenCalledWith(
      "update_channel",
      JSON.stringify(CHANNEL),
    ),
  );
  await vi.waitFor(() => expect(select).toHaveTextContent("# updates"));
});

it("shows the saved channel and clears it with No channel", async () => {
  const e = engine({ role: "admin", updateChannel: CHANNEL });
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  const select = await screen.findByRole("combobox", {
    name: "Update channel",
  });
  await vi.waitFor(() => expect(select).toHaveTextContent("# updates"));
  await userEvent.click(select);
  await userEvent.click(
    await screen.findByRole("option", { name: "No channel" }),
  );
  await vi.waitFor(() =>
    expect(e.calls.setCommunitySetting).toHaveBeenCalledWith(
      "update_channel",
      "",
    ),
  );
});

it("keeps the saved channel and shows the engine's answer when it refuses a channel", async () => {
  const e = engine({ role: "admin", updateChannel: OTHER });
  e.calls.setCommunitySetting.mockRejectedValue(
    new Error("add the Beehive account to this channel, then save again"),
  );
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  const select = await screen.findByRole("combobox", {
    name: "Update channel",
  });
  await vi.waitFor(() => expect(select).toHaveTextContent("# general"));
  await userEvent.click(select);
  await userEvent.click(
    await screen.findByRole("option", { name: "# updates" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "add the Beehive account to this channel, then save again",
  );
  expect(select).toHaveTextContent("# general");
});

it("shows the update channel to a person who is not an admin without a way to change it", async () => {
  const e = engine({ role: "run", updateChannel: CHANNEL });
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  const select = await screen.findByRole("combobox", {
    name: "Update channel",
  });
  await vi.waitFor(() => expect(select).toHaveTextContent("# updates"));
  expect(select).toBeDisabled();
});

const ADA = "a".repeat(64);
const BEN = "b".repeat(64);
const BOT = "c".repeat(64);
const access = () => [
  create(AccessEntrySchema, {
    pubkey: ADA,
    name: "Ada",
    kind: "person",
    level: "admin",
  }),
  create(AccessEntrySchema, {
    pubkey: BEN,
    name: "Ben",
    kind: "person",
    level: "read",
  }),
  create(AccessEntrySchema, {
    pubkey: BOT,
    name: "builder",
    kind: "agent",
    ownerPubkey: BEN,
    level: "read",
  }),
];

it("lists everyone's level for an admin and saves a change from the row", async () => {
  const e = engine({ role: "admin", access: access() });
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  const ben = await screen.findByRole("combobox", { name: "Level for Ben" });
  expect(ben).toHaveTextContent("Read");
  expect(
    screen.getByRole("combobox", { name: "Level for Ada" }),
  ).toHaveTextContent("Admin");
  expect(
    screen.getByRole("combobox", { name: "Level for builder" }),
  ).toHaveTextContent("Read");
  await userEvent.click(ben);
  await userEvent.click(await screen.findByRole("option", { name: /Run/ }));
  await vi.waitFor(() =>
    expect(e.calls.setAccessLevel).toHaveBeenCalledWith(
      BEN,
      "run",
      expect.anything(),
    ),
  );
  // The list is read again, so the row shows what the engine now holds.
  await vi.waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Level for Ben" }),
    ).toHaveTextContent("Run"),
  );
  expect(e.calls.listAccess.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("says the level saved when only the list read afterwards failed, and Retry reads the list again", async () => {
  const e = engine({ role: "admin", access: access() });
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Level for Ben" }),
  );
  e.calls.listAccess.mockRejectedValueOnce(
    new Error("Beehive is not reachable"),
  );
  await userEvent.click(await screen.findByRole("option", { name: /Run/ }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Saved, but the list could not be refreshed. Beehive is not reachable",
  );
  expect(alert).not.toHaveTextContent(/could not be saved/);
  expect(e.calls.setAccessLevel).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Level for Ben" }),
    ).toHaveTextContent("Run"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not offer an agent a level above its owner's", async () => {
  const e = engine({ role: "admin", access: access() });
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Level for builder" }),
  );
  expect(await screen.findByRole("option", { name: /Run/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("option", { name: /Admin/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("option", { name: /None/ })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("shows the engine's answer beside the row when a change is refused", async () => {
  const e = engine({ role: "admin", access: access() });
  e.calls.setAccessLevel.mockRejectedValueOnce(
    new Error("agent builder is capped at read by its owner Ben"),
  );
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Level for Ben" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: /Run/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("capped at read");
  expect(
    screen.getByRole("combobox", { name: "Level for Ben" }),
  ).toHaveTextContent("Read");
});

it("gives a person who is not an admin no access list", async () => {
  const e = engine({ role: "run", access: access() });
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  await screen.findByRole("combobox", { name: "Update channel" });
  expect(screen.queryByRole("combobox", { name: "Level for Ben" })).toBeNull();
  expect(e.calls.listAccess).not.toHaveBeenCalled();
});

it("says so when the settings cannot be read and Retry reads them again", async () => {
  const e = engine({ role: "admin" });
  e.calls.getCommunitySettings.mockRejectedValueOnce(
    new Error("Beehive is not reachable"),
  );
  page(e.client, undefined, channels);
  await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("combobox", { name: "Update channel" }),
  ).toBeVisible();
});

it("lets a person who can run turn auto mode on and off, and reads the card again", async () => {
  const e = engine();
  page(e.client, cardView);
  const toggle = await screen.findByRole("switch", { name: "Auto mode" });
  expect(toggle).not.toBeChecked();
  e.calls.getCard.mockResolvedValue(card({ autoMode: true }));
  await userEvent.click(toggle);
  await vi.waitFor(() =>
    expect(e.calls.setAutoMode).toHaveBeenCalledWith(ID, true),
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("switch", { name: "Auto mode" })).toBeChecked(),
  );

  e.calls.getCard.mockResolvedValue(card({ autoMode: false }));
  await userEvent.click(screen.getByRole("switch", { name: "Auto mode" }));
  await vi.waitFor(() =>
    expect(e.calls.setAutoMode).toHaveBeenLastCalledWith(ID, false),
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("switch", { name: "Auto mode" })).not.toBeChecked(),
  );
});

it("shows the engine's refusal to turn auto mode on", async () => {
  const e = engine();
  e.calls.setAutoMode.mockRejectedValue(
    new Error(
      "an agent may turn on auto mode only for a person at Run or above",
    ),
  );
  page(e.client, cardView);
  await userEvent.click(
    await screen.findByRole("switch", { name: "Auto mode" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "only for a person at Run or above",
  );
  expect(screen.getByRole("switch", { name: "Auto mode" })).not.toBeChecked();
});

it("hides the auto mode switch below Run and on an archived card, and still says when it is on", async () => {
  const reader = engine({ role: "read" });
  reader.calls.getCard.mockResolvedValue(card({ autoMode: true }));
  page(reader.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  await levelApplied(reader);
  expect(screen.queryByRole("switch", { name: "Auto mode" })).toBeNull();
  expect(await screen.findByText("Auto mode")).toBeVisible();
  expect(screen.getByText("On")).toBeVisible();
  cleanup();

  const archived = engine();
  archived.calls.getCard.mockResolvedValue(card({ archived: true }));
  page(archived.client, cardView);
  await screen.findByRole("button", { name: "Restore" });
  await levelApplied(archived);
  expect(screen.queryByRole("switch", { name: "Auto mode" })).toBeNull();
});
