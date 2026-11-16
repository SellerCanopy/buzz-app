import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import {
  ALL,
  NO_FILTERS,
  chipsOf,
  CARD_STATES,
  currentStage,
  inState,
  stateWords,
  laneOf,
  latestRuns,
  matchesText,
  passes,
  progressOf,
  repoOf,
  statusOf,
  stripOf,
  waitingByCard,
} from "./boardModel";
import {
  CardSchema,
  InboxItemSchema,
  RunSchema,
  RunStepSchema,
  WorkflowSchema,
} from "./gen/kiln/engine/v1/engine_pb";

const card = (workflow: string, state: string, more = {}) =>
  create(CardSchema, { id: "a", title: "A", workflow, state, ...more });
const workflow = create(WorkflowSchema, {
  name: "rpi",
  stages: ["plan", "plan_review", "implement", "code_review"].map((id) => ({
    id,
  })),
});
const step = (stage: string, fields = {}) =>
  create(RunStepSchema, { stage, visit: 1, round: 1, ...fields });

it("puts a card with no workflow in Backlog whatever its state says", () => {
  for (const state of ["idle", "running", "waiting", "failed", "done", ""])
    expect(laneOf(card("", state))).toBe("backlog");
});

it("places a card with a workflow in one of the other three lanes by its state", () => {
  const expected: [string, string][] = [
    ["idle", "todo"],
    ["", "todo"],
    ["running", "progress"],
    ["waiting", "progress"],
    ["failed", "progress"],
    ["stopped", "progress"],
    ["done", "done"],
    // A state this app does not know yet is still on the board.
    ["unheard-of", "todo"],
  ];
  for (const [state, lane] of expected)
    expect(laneOf(card("rpi", state)), state).toBe(lane);
});

it("names the repo of the card's issue, and none for a card without one", () => {
  const issue = {
    host: "github.com",
    owner: "example-org",
    repo: "api",
    number: 7,
  };
  expect(repoOf(card("", "idle", { issue }))).toBe("example-org/api");
  expect(repoOf(card("", "idle"))).toBe("");
});

it("names the first repo of a card with repos and no issue, the one a run works in", () => {
  const repos = [
    { repo: { host: "github.com", owner: "example-org", repo: "web" } },
    { repo: { host: "github.com", owner: "example-org", repo: "api" } },
  ];
  expect(repoOf(card("rpi", "idle", { repos }))).toBe("example-org/web");
});

it("counts the stages of the newest run that passed or were skipped", () => {
  const run = create(RunSchema, {
    cardId: "a",
    state: "running",
    stageId: "implement",
    steps: [
      step("plan", { result: "passed" }),
      step("plan_review", { skipped: true }),
      step("implement"),
    ],
  });
  expect(progressOf(card("rpi", "running"), run, workflow)).toEqual({
    done: 2,
    total: 4,
  });
  // A stage that ran twice counts by its newest step.
  const again = create(RunSchema, {
    cardId: "a",
    state: "running",
    steps: [
      step("plan", { result: "passed" }),
      step("plan", { result: "needs_work", round: 2 }),
    ],
  });
  expect(progressOf(card("rpi", "running"), again, workflow)?.done).toBe(0);
});

it("has no progress without the workflow, none done before a run, and all done when finished", () => {
  expect(progressOf(card("rpi", "idle"), undefined, undefined)).toBeUndefined();
  expect(progressOf(card("rpi", "idle"), undefined, workflow)).toEqual({
    done: 0,
    total: 4,
  });
  expect(progressOf(card("rpi", "done"), undefined, workflow)).toEqual({
    done: 4,
    total: 4,
  });
});

it("lists the stages a run reached with where each stands, then the next one", () => {
  const run = create(RunSchema, {
    cardId: "a",
    state: "ended",
    steps: [
      step("plan", { result: "passed" }),
      step("plan_review", { result: "passed" }),
      step("implement", { result: "failed" }),
    ],
  });
  expect(chipsOf(run, workflow)).toEqual([
    { stage: "plan", status: "done" },
    { stage: "plan_review", status: "done" },
    { stage: "implement", status: "failed" },
    { stage: "code_review", status: "next" },
  ]);
  const running = create(RunSchema, {
    cardId: "a",
    state: "running",
    stageId: "plan",
    steps: [step("plan")],
  });
  expect(chipsOf(running, workflow)[0]).toEqual({
    stage: "plan",
    status: "running",
  });
});

it("lists the first two stages of a card that has not run, and none without a workflow", () => {
  expect(chipsOf(undefined, workflow).map((chip) => chip.stage)).toEqual([
    "plan",
    "plan_review",
  ]);
  expect(chipsOf(undefined, undefined)).toEqual([]);
});

it("takes the newest run of each card by when it started", () => {
  const at = (seconds: number) => timestampFromDate(new Date(seconds * 1000));
  const runs = [
    create(RunSchema, { id: "old", cardId: "a", startedAt: at(10) }),
    create(RunSchema, { id: "new", cardId: "a", startedAt: at(20) }),
    create(RunSchema, { id: "other", cardId: "b", startedAt: at(5) }),
  ];
  const latest = latestRuns(runs);
  expect(latest.get("a")?.id).toBe("new");
  expect(latest.get("b")?.id).toBe("other");
});

const item = (kind: string, fields = {}) =>
  create(InboxItemSchema, { id: kind, cardId: "a", kind, ...fields });

it("says what a card waits for from its open inbox items, before its state", () => {
  expect(statusOf(card("rpi", "waiting"), [item("approval")]).label).toBe(
    "Ready for review",
  );
  expect(statusOf(card("rpi", "waiting"), [item("question")]).label).toBe(
    "Question for you",
  );
  expect(statusOf(card("rpi", "waiting"), [item("route")])).toEqual({
    label: "Needs you",
    tone: "danger",
  });
  expect(statusOf(card("rpi", "failed"), [])).toEqual({
    label: "Needs you",
    tone: "danger",
  });
  expect(statusOf(card("rpi", "running"), []).label).toBe("Running");
  expect(statusOf(card("", "idle"), []).label).toBe("Idle");
  expect(statusOf(card("rpi", "done"), []).label).toBe("Done");
});

it("groups only the open items by card", () => {
  const resolved = item("approval", {
    id: "x",
    resolvedAt: { seconds: 1n, nanos: 0 },
  });
  const grouped = waitingByCard([
    item("question"),
    resolved,
    item("route", { cardId: "" }),
  ]);
  expect([...grouped.keys()]).toEqual(["a"]);
  expect(grouped.get("a")).toHaveLength(1);
});

it("matches the search text against the title and the issue number", () => {
  const issue = { host: "github.com", owner: "o", repo: "r", number: 341 };
  const c = card("", "idle", { title: "Fix the login loop", issue });
  expect(matchesText(c, "")).toBe(true);
  expect(matchesText(c, "LOGIN")).toBe(true);
  expect(matchesText(c, "#341")).toBe(true);
  expect(matchesText(c, "341")).toBe(true);
  expect(matchesText(c, "#34")).toBe(false);
  expect(matchesText(card("", "idle", { title: "Fix" }), "#1")).toBe(false);
});

it("lets a card through only when it passes every filter, except the one skipped", () => {
  const issue = { host: "github.com", owner: "o", repo: "r", number: 1 };
  const c = card("rpi", "running", { issue });
  expect(passes(c, NO_FILTERS)).toBe(true);
  expect(passes(c, { ...NO_FILTERS, state: "idle" })).toBe(false);
  expect(passes(c, { ...NO_FILTERS, state: "idle" }, "state")).toBe(true);
  expect(passes(c, { ...NO_FILTERS, repo: "o/r" })).toBe(true);
  expect(passes(c, { ...NO_FILTERS, repo: "o/x" })).toBe(false);
  expect(passes(c, { ...NO_FILTERS, workflow: "none" })).toBe(false);
  expect(passes(card("", "idle"), { ...NO_FILTERS, workflow: "none" })).toBe(
    true,
  );
  expect(NO_FILTERS.state).toBe(ALL);
});

it("lists every stage of the workflow, with how the run stands in each", () => {
  const run = create(RunSchema, {
    state: "waiting",
    stageId: "plan_review",
    steps: [
      step("plan", { result: "passed", routedTo: "plan_review" }),
      step("plan_review"),
    ],
  });
  const strip = stripOf(run, workflow);
  expect(strip).toEqual([
    { stage: "plan", status: "done" },
    { stage: "plan_review", status: "running" },
    { stage: "implement", status: "idle" },
    { stage: "code_review", status: "idle" },
  ]);
  expect(currentStage(run, strip)).toBe(1);
  expect(stripOf(undefined, workflow).map((c) => c.status)).toEqual([
    "idle",
    "idle",
    "idle",
    "idle",
  ]);
  expect(stripOf(run, undefined)).toEqual([]);
  expect(currentStage(undefined, strip)).toBeUndefined();
});

it("names the last stage reached when the run has ended", () => {
  const run = create(RunSchema, {
    state: "ended",
    stageId: "",
    steps: [
      step("plan", { result: "passed" }),
      step("plan_review", { result: "failed" }),
    ],
  });
  const strip = stripOf(run, workflow);
  expect(strip[1]?.status).toBe("failed");
  expect(currentStage(run, strip)).toBe(1);
});

it("owns each state's label, lane and tone in one table, and reads an unknown state as To do", () => {
  expect(Object.keys(CARD_STATES)).toEqual([
    "idle",
    "running",
    "waiting",
    "failed",
    "stopped",
    "done",
  ]);
  for (const state of Object.keys(CARD_STATES)) {
    const placed = card("rpi", state);
    expect(laneOf(placed)).toBe(
      CARD_STATES[state as keyof typeof CARD_STATES].lane,
    );
    // A failed card reads as one that needs the person.
    if (state !== "failed")
      expect(statusOf(placed, [])).toMatchObject({
        label: CARD_STATES[state as keyof typeof CARD_STATES].label,
      });
    expect(stateWords(state)).toBe(
      CARD_STATES[state as keyof typeof CARD_STATES].label,
    );
    expect(inState(placed, state as keyof typeof CARD_STATES)).toBe(true);
  }
  const odd = card("rpi", "unheard-of");
  expect(laneOf(odd)).toBe("todo");
  expect(inState(odd, "idle", "running")).toBe(false);
  // Names that sit on Object.prototype are not states.
  expect(inState(card("rpi", "constructor"), "idle")).toBe(false);
  expect(stateWords("constructor")).toBe("constructor");
});
