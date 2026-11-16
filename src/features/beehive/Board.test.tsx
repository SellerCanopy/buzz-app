// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Board } from "./Board";
import type { Client } from "./engine/client";
import {
  CardSchema,
  InboxItemSchema,
  ListCardsResponseSchema,
  ListRunsResponseSchema,
  ListWorkflowsResponseSchema,
  RunSchema,
  RunStepSchema,
  type Card,
  type InboxItem,
  type Run,
} from "./gen/kiln/engine/v1/engine_pb";

afterEach(cleanup);

const card = (fields: MessageInitShape<typeof CardSchema>) =>
  create(CardSchema, { title: "A card", ...fields });
const issue = (number: number) => ({
  host: "github.com",
  owner: "example-org",
  repo: "api",
  number,
});

type Setup = {
  cards?: Card[];
  archived?: Card[];
  runs?: Run[];
  inbox?: InboxItem[];
  canRun?: boolean;
  archivedView?: boolean;
};

/** The Board over a fake engine whose polls never answer. */
function board(setup: Setup = {}) {
  const client = {
    listCards: vi.fn(async (archived = false) =>
      create(ListCardsResponseSchema, {
        cards: archived ? (setup.archived ?? []) : (setup.cards ?? []),
        seq: 5n,
      }),
    ),
    listRuns: vi.fn(async () =>
      create(ListRunsResponseSchema, { runs: setup.runs ?? [], seq: 5n }),
    ),
    listWorkflows: vi.fn(async () =>
      create(ListWorkflowsResponseSchema, {
        workflows: [
          { name: "rpi", ok: true, stages: [{ id: "plan" }, { id: "build" }] },
          { name: "task", ok: true, stages: [{ id: "do" }] },
          { name: "broken", ok: false },
        ],
      }),
    ),
    pollEvents: vi.fn(() => new Promise(() => {})),
    startRun: vi.fn(async () => create(RunSchema, { id: "run-9" })),
    retryRun: vi.fn(async () => create(RunSchema, { id: "run-10" })),
    restoreCard: vi.fn(async () => card({ id: "x" })),
    setCardWorkflow: vi.fn(async () => ({})),
    archiveCards: vi.fn(async () => ({})),
  };
  const props = {
    onArchived: vi.fn(),
    onOpen: vi.fn(),
    onNew: vi.fn(),
    onNewFromIssue: vi.fn(),
    onAskAssistant: vi.fn(),
    onOpenNeedsYou: vi.fn(),
  };
  render(
    <Board
      client={client as unknown as Client}
      canRun={setup.canRun ?? true}
      archived={setup.archivedView ?? false}
      waiting={setup.inbox ?? []}
      {...props}
    />,
  );
  return { calls: client, ...props };
}

const lane = (name: string) => screen.getByRole("region", { name });
/** The tile of the card with this title in a lane. */
const tile = (laneName: string, title: string) =>
  within(lane(laneName))
    .getByRole("button", { name: title })
    .closest("li") as HTMLElement;
const loaded = () => screen.findByRole("region", { name: "Backlog" });

it("shows a tile with its workflow, repo, step chips, progress and status", async () => {
  const run = create(RunSchema, {
    id: "r1",
    cardId: "a",
    state: "running",
    stageId: "build",
    steps: [
      create(RunStepSchema, {
        stage: "plan",
        visit: 1,
        round: 1,
        result: "passed",
      }),
      create(RunStepSchema, { stage: "build", visit: 1, round: 1 }),
    ],
  });
  board({
    cards: [
      card({
        id: "a",
        title: "Fix login",
        workflow: "rpi",
        state: "running",
        issue: issue(341),
      }),
    ],
    runs: [run],
  });
  await loaded();
  const card1 = tile("In progress", "Fix login");
  expect(within(card1).getByText("rpi")).toBeVisible();
  expect(within(card1).getByText("example-org/api#341")).toBeVisible();
  const steps = within(card1).getByRole("list", { name: "Steps" });
  expect(steps).toHaveTextContent("plan, done");
  expect(steps).toHaveTextContent("build, running");
  expect(within(card1).getByText("1 of 2")).toBeVisible();
  expect(within(card1).getByText("Running")).toBeVisible();
  expect(
    within(lane("In progress")).getByRole("img", { name: "1 card" }),
  ).toBeVisible();
});

it("says No repo for a card without an issue and not started for one that never ran", async () => {
  board({ cards: [card({ id: "a", title: "Loose idea" })] });
  await loaded();
  const card1 = tile("Backlog", "Loose idea");
  expect(within(card1).getByText("No workflow")).toBeVisible();
  expect(within(card1).getByText("No repo")).toBeVisible();
  expect(within(card1).getByText("not started")).toBeVisible();
});

it("shows the first repo of a card that has repos but no issue", async () => {
  board({
    cards: [
      card({
        id: "a",
        title: "Loose idea",
        repos: [
          {
            repo: { host: "github.com", owner: "example-org", repo: "web" },
            main: true,
          },
        ],
      }),
    ],
  });
  await loaded();
  const card1 = tile("Backlog", "Loose idea");
  expect(within(card1).getByText("example-org/web")).toBeVisible();
  expect(within(card1).queryByText("No repo")).toBeNull();
});

it("folds a lane away to its heading and opens it again", async () => {
  const user = userEvent.setup();
  board({ cards: [card({ id: "a", title: "Loose idea" })] });
  await loaded();
  await user.click(screen.getByRole("button", { name: "Collapse Backlog" }));
  expect(screen.queryByText("Loose idea")).toBeNull();
  // The count stays on the folded lane.
  expect(
    within(lane("Backlog")).getByRole("img", { name: "1 card" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Expand Backlog" }));
  expect(screen.getByText("Loose idea")).toBeVisible();
});

it("opens a card from its title", async () => {
  const user = userEvent.setup();
  const b = board({ cards: [card({ id: "a", title: "Loose idea" })] });
  await user.click(await screen.findByRole("button", { name: "Loose idea" }));
  expect(b.onOpen).toHaveBeenCalledWith("a");
});

it("starts a run on an idle card with a workflow and shows the engine's refusal", async () => {
  const user = userEvent.setup();
  const b = board({
    cards: [card({ id: "a", title: "Ready", workflow: "rpi", state: "idle" })],
  });
  b.calls.startRun.mockRejectedValueOnce(
    new Error(
      "choose an update channel in Beehive settings before starting a run",
    ),
  );
  await user.click(
    await screen.findByRole("button", { name: "Start run on Ready" }),
  );
  expect(b.calls.startRun).toHaveBeenCalledWith("a");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "choose an update channel in Beehive settings before starting a run",
  );
  // The engine's refusal leaves the button ready for another try.
  await user.click(screen.getByRole("button", { name: "Start run on Ready" }));
  expect(b.calls.startRun).toHaveBeenCalledTimes(2);
});

it("retries the run of a failed card, and offers it for no other state", async () => {
  const user = userEvent.setup();
  const ended = create(RunSchema, { id: "r1", cardId: "a", state: "ended" });
  const b = board({
    cards: [
      card({ id: "a", title: "Broke", workflow: "rpi", state: "failed" }),
      card({ id: "b", title: "Fine", workflow: "rpi", state: "done" }),
    ],
    runs: [ended, create(RunSchema, { id: "r2", cardId: "b", state: "ended" })],
  });
  await loaded();
  await user.click(await screen.findByRole("button", { name: "Retry run" }));
  expect(b.calls.retryRun).toHaveBeenCalledWith("r1");
  expect(screen.getAllByRole("button", { name: "Retry run" })).toHaveLength(1);
});

it("moves an unstarted card to Backlog or to a workflow, never into In progress or Done", async () => {
  const user = userEvent.setup();
  const b = board({
    cards: [card({ id: "a", title: "Ready", workflow: "rpi", state: "idle" })],
  });
  await user.click(await screen.findByRole("button", { name: "Move Ready" }));
  const items = (await screen.findAllByRole("menuitem")).map(
    (item) => item.textContent,
  );
  // The current workflow and a workflow that did not load are left out.
  expect(items).toEqual(["Backlog", "task"]);
  await user.click(screen.getByRole("menuitem", { name: "Backlog" }));
  expect(b.calls.setCardWorkflow).toHaveBeenCalledWith([
    { cardId: "a", workflow: "" },
  ]);
});

it("does not offer Move on a card that has run, or to a person who cannot run", async () => {
  board({
    cards: [
      card({ id: "a", title: "Going", workflow: "rpi", state: "running" }),
    ],
    runs: [create(RunSchema, { id: "r1", cardId: "a", state: "running" })],
  });
  await loaded();
  expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull();
  cleanup();
  board({
    canRun: false,
    cards: [card({ id: "a", title: "Ready", workflow: "rpi", state: "idle" })],
  });
  await loaded();
  expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Start run/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New card" })).toBeNull();
  expect(screen.queryByRole("button", { name: "From an issue" })).toBeNull();
  // Reading still works: Refresh stays.
  expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
});

it("narrows the cards by search text, state, repo and workflow, counting what each choice would show", async () => {
  const user = userEvent.setup();
  board({
    cards: [
      card({
        id: "a",
        title: "Fix login",
        workflow: "rpi",
        state: "running",
        issue: issue(341),
      }),
      card({ id: "b", title: "Add retry", workflow: "task", state: "idle" }),
      card({ id: "c", title: "Loose idea", state: "idle" }),
    ],
  });
  await loaded();
  expect(screen.getAllByRole("tab", { name: "All 3" })).not.toHaveLength(0);
  // Search by title, and by #number.
  await user.type(
    screen.getByRole("searchbox", { name: "Search cards" }),
    "retry",
  );
  expect(screen.queryByText("Fix login")).toBeNull();
  expect(screen.getByText("Add retry")).toBeVisible();
  await user.clear(screen.getByRole("searchbox", { name: "Search cards" }));
  await user.type(
    screen.getByRole("searchbox", { name: "Search cards" }),
    "#341",
  );
  expect(screen.getByText("Fix login")).toBeVisible();
  expect(screen.queryByText("Add retry")).toBeNull();
  await user.clear(screen.getByRole("searchbox", { name: "Search cards" }));

  await user.click(screen.getByRole("tab", { name: "Idle 2" }));
  expect(screen.queryByText("Fix login")).toBeNull();
  expect(screen.getByText("Add retry")).toBeVisible();
  expect(screen.getByText("Loose idea")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "No workflow 1" }));
  expect(screen.queryByText("Add retry")).toBeNull();
  expect(screen.getByText("Loose idea")).toBeVisible();
  // No card left is in a repo, so that choice is no longer offered.
  expect(screen.queryByRole("tab", { name: /^example-org\/api/ })).toBeNull();
});

it("says how many cards need you and opens Needs you", async () => {
  const user = userEvent.setup();
  const b = board({
    cards: [
      card({ id: "a", title: "Plan it", workflow: "rpi", state: "waiting" }),
      card({ id: "b", title: "Other", workflow: "rpi", state: "idle" }),
    ],
    inbox: [
      create(InboxItemSchema, {
        id: "i1",
        cardId: "a",
        kind: "approval",
        title: "Approve the plan",
        cardTitle: "Plan it",
      }),
    ],
  });
  const notice = await screen.findByRole("region", {
    name: "Cards that need you",
  });
  expect(within(notice).getByText("1 card needs you")).toBeVisible();
  expect(within(notice).getByText("Approve the plan")).toBeVisible();
  // The card says what it waits for, and offers Review.
  const card1 = tile("In progress", "Plan it");
  expect(within(card1).getByText("Ready for review")).toBeVisible();
  await user.click(within(card1).getByRole("button", { name: "Review" }));
  expect(b.onOpen).toHaveBeenCalledWith("a");
  await user.click(
    within(notice).getByRole("button", { name: "Open Needs you" }),
  );
  expect(b.onOpenNeedsYou).toHaveBeenCalled();
});

it("shows no notice when nothing waits", async () => {
  board({ cards: [card({ id: "a", title: "Loose" })] });
  await loaded();
  expect(
    screen.queryByRole("region", { name: "Cards that need you" }),
  ).toBeNull();
});

it("selects cards, moves them together, archives them and clears the choice", async () => {
  const user = userEvent.setup();
  const b = board({
    cards: [
      card({ id: "a", title: "One", state: "idle" }),
      card({ id: "b", title: "Two", state: "idle" }),
      card({ id: "c", title: "Three", state: "idle" }),
    ],
  });
  await loaded();
  expect(screen.queryByRole("checkbox")).toBeNull();
  const select = screen.getByRole("button", { name: "Select" });
  expect(select).toHaveAttribute("aria-pressed", "false");
  await user.click(select);
  expect(select).toHaveAttribute("aria-pressed", "true");
  const bar = screen.getByRole("toolbar", { name: "Selected cards" });
  expect(within(bar).getByText("0 selected")).toBeVisible();
  expect(within(bar).getByRole("button", { name: "Move to" })).toBeDisabled();

  await user.click(screen.getByRole("checkbox", { name: "Select One" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Two" }));
  expect(within(bar).getByText("2 selected")).toBeVisible();
  await user.click(within(bar).getByRole("button", { name: "Move to" }));
  await user.click(await screen.findByRole("menuitem", { name: "rpi" }));
  expect(b.calls.setCardWorkflow).toHaveBeenCalledWith([
    { cardId: "a", workflow: "rpi" },
    { cardId: "b", workflow: "rpi" },
  ]);
  // The choice is cleared once the move is made.
  await vi.waitFor(() =>
    expect(within(bar).getByText("0 selected")).toBeVisible(),
  );

  await user.click(screen.getByRole("checkbox", { name: "Select Three" }));
  await user.click(within(bar).getByRole("button", { name: "Move to" }));
  await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(b.calls.archiveCards).toHaveBeenCalledWith(["c"]);

  await user.click(screen.getByRole("checkbox", { name: "Select One" }));
  await user.click(within(bar).getByRole("button", { name: "Clear" }));
  expect(within(bar).getByText("0 selected")).toBeVisible();
  // Leaving select mode removes the bar and the boxes.
  await user.click(select);
  expect(screen.queryByRole("toolbar", { name: "Selected cards" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("acts only on the selected cards a filter still shows", async () => {
  const user = userEvent.setup();
  const b = board({
    cards: [
      card({ id: "a", title: "Login bug", state: "idle" }),
      card({ id: "b", title: "Docs fix", state: "idle" }),
    ],
  });
  await loaded();
  await user.click(screen.getByRole("button", { name: "Select" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Login bug" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Docs fix" }));
  const bar = screen.getByRole("toolbar", { name: "Selected cards" });
  expect(within(bar).getByText("2 selected")).toBeVisible();

  // A search hides one of them, and the count follows what is shown.
  await user.type(
    screen.getByRole("searchbox", { name: "Search cards" }),
    "login",
  );
  expect(await within(bar).findByText("1 selected")).toBeVisible();
  await user.click(within(bar).getByRole("button", { name: "Move to" }));
  await user.click(await screen.findByRole("menuitem", { name: "rpi" }));
  expect(b.calls.setCardWorkflow).toHaveBeenCalledWith([
    { cardId: "a", workflow: "rpi" },
  ]);

  await user.click(screen.getByRole("checkbox", { name: "Select Login bug" }));
  await user.click(within(bar).getByRole("button", { name: "Move to" }));
  await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(b.calls.archiveCards).toHaveBeenCalledWith(["a"]);
});

it("moves only the selected cards that have not started, and says the others stayed", async () => {
  const user = userEvent.setup();
  const b = board({
    cards: [
      card({ id: "a", title: "Idle one", state: "idle" }),
      card({
        id: "b",
        title: "Running one",
        workflow: "task",
        state: "running",
      }),
    ],
    runs: [create(RunSchema, { id: "r1", cardId: "b", state: "running" })],
  });
  await loaded();
  await user.click(screen.getByRole("button", { name: "Select" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Idle one" }));
  await user.click(
    screen.getByRole("checkbox", { name: "Select Running one" }),
  );
  const bar = screen.getByRole("toolbar", { name: "Selected cards" });
  await user.click(within(bar).getByRole("button", { name: "Move to" }));
  await user.click(await screen.findByRole("menuitem", { name: "rpi" }));
  // The engine refuses a whole batch with a started card, so only the idle one is sent.
  expect(b.calls.setCardWorkflow).toHaveBeenCalledWith([
    { cardId: "a", workflow: "rpi" },
  ]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cards that have started cannot move, so they were left where they are.",
  );
});

it("sends nothing and says why when none of the selected cards can move", async () => {
  const user = userEvent.setup();
  const b = board({
    cards: [
      card({
        id: "b",
        title: "Running one",
        workflow: "task",
        state: "running",
      }),
    ],
    runs: [create(RunSchema, { id: "r1", cardId: "b", state: "running" })],
  });
  await loaded();
  await user.click(screen.getByRole("button", { name: "Select" }));
  await user.click(
    screen.getByRole("checkbox", { name: "Select Running one" }),
  );
  await user.click(screen.getByRole("button", { name: "Move to" }));
  await user.click(await screen.findByRole("menuitem", { name: "rpi" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cards that have started cannot move",
  );
  expect(b.calls.setCardWorkflow).not.toHaveBeenCalled();
});

it("keeps the selection and shows the engine's refusal when a move fails", async () => {
  const user = userEvent.setup();
  const b = board({ cards: [card({ id: "a", title: "One" })] });
  b.calls.archiveCards.mockRejectedValueOnce(new Error("the card is running"));
  await loaded();
  await user.click(screen.getByRole("button", { name: "Select" }));
  await user.click(screen.getByRole("checkbox", { name: "Select One" }));
  await user.click(screen.getByRole("button", { name: "Move to" }));
  await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the card is running",
  );
  expect(screen.getByText("1 selected")).toBeVisible();
});

it("lists archived cards with Restore, or Back to Backlog when there is no workflow", async () => {
  const user = userEvent.setup();
  const b = board({
    archivedView: true,
    cards: [card({ id: "a", title: "Live" })],
    archived: [
      card({ id: "x", title: "Old spike", workflow: "task", archived: true }),
      card({ id: "y", title: "Idea", archived: true }),
    ],
  });
  const list = await screen.findByRole("list", { name: "Archived cards" });
  expect(within(list).getByText("Old spike")).toBeVisible();
  expect(screen.queryByText("Live")).toBeNull();
  await user.click(
    within(list).getByRole("button", { name: "Restore Old spike" }),
  );
  expect(b.calls.restoreCard).toHaveBeenCalledWith("x");
  await user.click(
    within(list).getByRole("button", { name: "Back to Backlog Idea" }),
  );
  expect(b.calls.restoreCard).toHaveBeenCalledWith("y");
  // Select mode belongs to the board's lanes.
  expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
});

it("leaves the archive from the Archived filter and counts the cards in it", async () => {
  const user = userEvent.setup();
  const b = board({
    archivedView: true,
    archived: [card({ id: "x", title: "Old", archived: true })],
  });
  const tab = await screen.findByRole("tab", { name: "Archived 1" });
  expect(tab).toHaveAttribute("aria-selected", "true");
  await user.click(tab);
  expect(b.onArchived).toHaveBeenCalledWith(false);
});

it("opens the new card form from the header, and the issue form from From an issue", async () => {
  const user = userEvent.setup();
  const b = board();
  await user.click(await screen.findByRole("button", { name: "New card" }));
  expect(b.onNew).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "From an issue" }));
  expect(b.onNewFromIssue).toHaveBeenCalled();
});

it("reads again in place when Refresh is pressed", async () => {
  const user = userEvent.setup();
  const b = board({ cards: [card({ id: "a", title: "Loose" })] });
  await loaded();
  expect(b.calls.listCards).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await vi.waitFor(() => expect(b.calls.listCards).toHaveBeenCalledTimes(4));
  // The board stayed on screen throughout.
  expect(screen.getByText("Loose")).toBeVisible();
});
