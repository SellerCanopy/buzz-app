// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { BeehivePage } from "./BeehivePage";
import { fakeRelay } from "./fake-relay";
import type { Client } from "./engine/client";
import {
  ArtifactInfoSchema,
  ArtifactVersionSchema,
  CardSchema,
  EventSchema,
  CheckWorkflowResponseSchema,
  ListArtifactsResponseSchema,
  ListArtifactVersionsResponseSchema,
  ListCardsResponseSchema,
  ListRunsResponseSchema,
  ListWorkflowsResponseSchema,
  GetSettingsResponseSchema,
  RunSchema,
  RunStepSchema,
  SettingSchema,
  StageThreadSchema,
  PollEventsResponseSchema,
  WhoAmIResponseSchema,
  type ArtifactVersion,
  type Card,
  type Run,
} from "./gen/kiln/engine/v1/engine_pb";
import { PAGE_ID, PLUGIN_ID } from "./routes";

afterEach(cleanup);

const ID = "0b8f4d1e-6c1f-4f0e-9d53-2f3f6a0a1c11";
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
    /** What the card's stages saved, every version of each, oldest first. */
    saved?: ArtifactVersion[];
  } = {},
) {
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
    setCommunitySetting: vi.fn(async (key: string, valueJson: string) =>
      create(SettingSchema, { key, valueJson }),
    ),
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

function page(client: Client, target?: OpenTarget, relay = fakeRelay([])) {
  const s = shell(target);
  render(
    <s.Host>
      {(props) => (
        <BeehivePage
          client={client}
          relay={relay}
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
  expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
  cleanup();

  const running = engine();
  running.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "running" }),
  );
  page(running.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
  expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
  cleanup();

  const reader = engine({ role: "read" });
  reader.calls.getCard.mockResolvedValue(
    card({ workflow: "demo", state: "idle" }),
  );
  page(reader.client, cardView);
  await screen.findByRole("tab", { name: "Details" });
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
