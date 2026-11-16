// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AssistantPanel, type AssistantSession } from "./AssistantPanel";
import type { Client } from "./engine/client";
import { EngineError } from "./engine/transport";
import { fakeRelay } from "./fake-relay";
import type { RelayData } from "../relay/service";
import {
  CheckWorkflowResponseSchema,
  EventSchema,
  GetSettingsResponseSchema,
  GetStatusResponseSchema,
  GetWorkflowDraftResponseSchema,
  ListProposalsResponseSchema,
  OpenProposalSchema,
  PollEventsResponseSchema,
  SaveWorkflowResponseSchema,
  SettingSchema,
  StartJobResponseSchema,
  type Event,
  type OpenProposal,
} from "./gen/kiln/engine/v1/engine_pb";

// A poll that drops waits a random time before it tries again: no wait keeps the test quick.
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CHANNEL = "5f1c2d3e-0000-4000-8000-000000000001";
const HEAD = 10n;
const running = (fields: Partial<AssistantSession> = {}): AssistantSession => ({
  root: "root-1",
  cursor: 7n,
  job: "job-1",
  failure: undefined,
  ...fields,
});
const idle: AssistantSession = {
  root: undefined,
  cursor: 0n,
  job: undefined,
  failure: undefined,
};

const encode = (text: string) => new TextEncoder().encode(text);
const PROPOSED = JSON.stringify({ version: 2, stages: [{ id: "review" }] });
const PACKAGE = JSON.stringify({ name: "rpi", version: "1" });
const proposal = (): OpenProposal =>
  create(OpenProposalSchema, {
    id: 5n,
    baseHash: "h1",
    jobId: "job-1",
    draft: {
      name: "rpi",
      files: {
        "kiln-package.yaml": encode(PACKAGE),
        "workflow.yaml": encode(PROPOSED),
      },
    },
  });

const event = (seq: bigint, type: string, body: object): Event =>
  create(EventSchema, { seq, type, payloadJson: JSON.stringify(body) });

/** The engine as the panel sees it, with a long poll the test answers or drops. */
function engine(options: { agent?: string; proposals?: OpenProposal[] } = {}) {
  const polls: {
    after: bigint;
    answer(events: Event[]): void;
    drop(code?: string): void;
  }[] = [];
  let open = options.proposals ?? [];
  const calls = {
    getCommunitySettings: vi.fn(async () =>
      create(GetSettingsResponseSchema, {
        settings: [
          create(SettingSchema, {
            key: "update_channel",
            valueJson: JSON.stringify(CHANNEL),
          }),
          create(SettingSchema, {
            key: "assistant_agent",
            valueJson:
              (options.agent ?? "builder") === ""
                ? "null"
                : JSON.stringify(options.agent ?? "builder"),
          }),
        ],
      }),
    ),
    listProposals: vi.fn(async () =>
      create(ListProposalsResponseSchema, { proposals: open }),
    ),
    getWorkflowDraft: vi.fn(async () =>
      create(GetWorkflowDraftResponseSchema, {
        hash: "h1",
        textFiles: {
          "kiln-package.yaml": PACKAGE,
          "workflow.yaml": JSON.stringify({ version: 2, stages: [] }),
        },
      }),
    ),
    checkDraft: vi.fn(async () => create(CheckWorkflowResponseSchema, {})),
    saveWorkflow: vi.fn(async (_draft: unknown, _base: string) =>
      create(SaveWorkflowResponseSchema, {
        hash: "h2",
        workflow: { name: "rpi", version: "3", own: true },
      }),
    ),
    resolveProposal: vi.fn(async (id: bigint, _accepted: boolean) => {
      open = open.filter((p) => p.id !== id);
      return {};
    }),
    acceptTicketProposal: vi.fn(async (id: bigint) => {
      open = open.filter((p) => p.id !== id);
      return {};
    }),
    getStatus: vi.fn(async () =>
      create(GetStatusResponseSchema, { headSeq: HEAD }),
    ),
    startChat: vi.fn(async (_text: string, _root: string) =>
      create(StartJobResponseSchema, { jobId: "job-1" }),
    ),
    cancelJob: vi.fn(async (_job: string) => ({})),
    pollEvents: vi.fn(
      (after: bigint, _wait?: number, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          polls.push({
            after,
            answer: (events) =>
              resolve(
                create(PollEventsResponseSchema, {
                  events,
                  nextSeq: events.at(-1)?.seq ?? after,
                }),
              ),
            drop: (code = "unavailable") =>
              reject(new EngineError(code, "Beehive is down", 503)),
          });
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ),
  };
  return {
    calls,
    polls,
    /** What ListProposals answers from now on. */
    offer: (next: OpenProposal[]) => {
      open = next;
    },
  };
}

/** The host's embedded thread, reduced to what the panel hands it. */
const Thread = (props: { channelId: string; messageId: string }) => (
  <div data-testid="thread" data-channel={props.channelId}>
    {props.messageId}
  </div>
);

function open(
  e: ReturnType<typeof engine>,
  props: {
    restored?: AssistantSession;
    canRun?: boolean;
    isAdmin?: boolean;
    relay?: RelayData;
  } = {},
) {
  const handlers = {
    onSession: vi.fn(),
    onSaved: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <ToastProvider>
      <AssistantPanel
        client={e.calls as unknown as Client}
        relay={props.relay ?? fakeRelay([{ id: CHANNEL, name: "updates" }])}
        Thread={Thread as never}
        canRun={props.canRun ?? true}
        isAdmin={props.isAdmin ?? false}
        restored={props.restored ?? idle}
        {...handlers}
      />
    </ToastProvider>,
  );
  return handlers;
}

const card = () =>
  screen.findByRole("region", { name: "Proposed edit to rpi" });
const lastSession = (h: { onSession: ReturnType<typeof vi.fn> }) =>
  h.onSession.mock.calls.at(-1)?.[0] as AssistantSession;

it("shows the proposal card with what changed, and applies it through SaveWorkflow at the hash the agent named", async () => {
  const e = engine({ proposals: [proposal()] });
  const handlers = open(e);
  const proposed = await card();
  // Only the workflow file differs from the saved version.
  expect(
    await within(proposed).findByText("Proposed edit: 1 file changed"),
  ).toBeVisible();
  expect(within(proposed).getByText("workflow.yaml")).toBeVisible();
  expect(within(proposed).getByText("Checks pass")).toBeVisible();
  await userEvent.click(
    within(proposed).getByRole("button", { name: "Show changes" }),
  );
  expect(
    within(proposed).getByRole("region", { name: "Proposed workflow.yaml" }),
  ).toHaveTextContent(PROPOSED);
  expect(
    within(proposed).getByRole("region", { name: "Current workflow.yaml" }),
  ).toHaveTextContent('"stages":[]');

  await userEvent.click(
    within(proposed).getByRole("button", { name: "Apply" }),
  );

  await vi.waitFor(() => expect(handlers.onSaved).toHaveBeenCalledTimes(1));
  expect(e.calls.saveWorkflow).toHaveBeenCalledTimes(1);
  expect(e.calls.saveWorkflow).toHaveBeenCalledWith(
    {
      name: "rpi",
      files: { "kiln-package.yaml": PACKAGE, "workflow.yaml": PROPOSED },
    },
    "h1",
  );
  expect(e.calls.resolveProposal).toHaveBeenCalledWith(5n, true);
  expect(
    screen.queryByRole("region", { name: "Proposed edit to rpi" }),
  ).toBeNull();
});

it("shows the engine's words when the workflow changed since the proposal, and keeps the card", async () => {
  const e = engine({ proposals: [proposal()] });
  e.calls.saveWorkflow.mockRejectedValue(
    new EngineError(
      "failed_precondition",
      "the workflow changed since you opened it; reload and try again",
      409,
    ),
  );
  const handlers = open(e);
  const proposed = await card();
  await userEvent.click(
    within(proposed).getByRole("button", { name: "Apply" }),
  );

  expect(await within(proposed).findByRole("alert")).toHaveTextContent(
    "the workflow changed since you opened it; reload and try again",
  );
  expect(e.calls.resolveProposal).not.toHaveBeenCalled();
  expect(handlers.onSaved).not.toHaveBeenCalled();
  // Still there, and Apply can be tried again.
  expect(within(proposed).getByRole("button", { name: "Apply" })).toBeEnabled();
});

it("still counts a proposal as applied when only recording the decision fails, because the version is saved", async () => {
  const e = engine({ proposals: [proposal()] });
  e.calls.resolveProposal.mockRejectedValue(new Error("gone"));
  const handlers = open(e);
  const proposed = await card();
  await userEvent.click(
    within(proposed).getByRole("button", { name: "Apply" }),
  );
  await vi.waitFor(() => expect(handlers.onSaved).toHaveBeenCalledTimes(1));
  expect(e.calls.saveWorkflow).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("region", { name: "Proposed edit to rpi" }),
  ).toBeNull();
});

it("shows the engine's words when Discard fails, and keeps the proposal", async () => {
  const e = engine({ proposals: [proposal()] });
  e.calls.resolveProposal.mockRejectedValue(new Error("the proposal is gone"));
  open(e);
  const proposed = await card();
  await userEvent.click(
    within(proposed).getByRole("button", { name: "Discard" }),
  );
  expect(await within(proposed).findByRole("alert")).toHaveTextContent(
    "the proposal is gone",
  );
  expect(
    within(proposed).getByRole("button", { name: "Discard" }),
  ).toBeEnabled();
});

it("compares a proposal for a package that is not saved yet with nothing", async () => {
  const e = engine({ proposals: [proposal()] });
  e.calls.getWorkflowDraft.mockRejectedValue(
    new EngineError("not_found", "no workflow rpi", 404),
  );
  open(e);
  const proposed = await card();
  // Both files are new.
  expect(
    await within(proposed).findByText("Proposed edit: 2 files changed"),
  ).toBeVisible();
  await userEvent.click(
    within(proposed).getByRole("button", { name: "Show changes" }),
  );
  expect(
    within(proposed).getAllByText("Not in the current version"),
  ).toHaveLength(2);
});

it("says so when a proposal cannot be compared with the saved version", async () => {
  const e = engine({ proposals: [proposal()] });
  e.calls.getWorkflowDraft.mockRejectedValue(
    new EngineError("unavailable", "Beehive is down", 503),
  );
  open(e);
  const proposed = await card();
  expect(await within(proposed).findByRole("alert")).toHaveTextContent(
    "Could not compare it with the saved version. Beehive is down",
  );
});

it("lists the problems the checks found in a proposal", async () => {
  const e = engine({ proposals: [proposal()] });
  e.calls.checkDraft.mockResolvedValue(
    create(CheckWorkflowResponseSchema, {
      packages: [
        {
          name: "rpi",
          findings: [
            { severity: "error", message: "stage review has no route" },
          ],
        },
      ],
    }),
  );
  open(e);
  const proposed = await card();
  expect(
    await within(proposed).findByText(/stage review has no route/),
  ).toBeVisible();
  expect(within(proposed).queryByText("Checks pass")).toBeNull();
});

it("discards a proposal without saving anything", async () => {
  const e = engine({ proposals: [proposal()] });
  const handlers = open(e);
  const proposed = await card();
  await userEvent.click(
    within(proposed).getByRole("button", { name: "Discard" }),
  );
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Proposed edit to rpi" }),
    ).toBeNull(),
  );
  expect(e.calls.resolveProposal).toHaveBeenCalledWith(5n, false);
  expect(e.calls.saveWorkflow).not.toHaveBeenCalled();
  expect(handlers.onSaved).not.toHaveBeenCalled();
});

const ticket = (): OpenProposal =>
  create(OpenProposalSchema, {
    id: 8n,
    ticket: {
      title: "Uploads time out over 50 MB",
      body: "The gateway drops the connection after 30 seconds.",
      repo: "example-org/upload-api",
    },
  });
const offered = () =>
  screen.findByRole("region", {
    name: "Proposed ticket: Uploads time out over 50 MB",
  });

it("shows a ticket an agent proposed and opens its issue when the person accepts", async () => {
  const e = engine({ proposals: [ticket()] });
  const handlers = open(e);
  const proposed = await offered();
  expect(within(proposed).getByText("example-org/upload-api")).toBeVisible();
  expect(
    within(proposed).getByText(
      "The gateway drops the connection after 30 seconds.",
    ),
  ).toBeVisible();
  // It is not a workflow, so nothing is compared or checked.
  expect(e.calls.getWorkflowDraft).not.toHaveBeenCalled();

  await userEvent.click(
    within(proposed).getByRole("button", { name: "Open issue" }),
  );

  await vi.waitFor(() =>
    expect(e.calls.acceptTicketProposal).toHaveBeenCalledWith(8n),
  );
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("region", { name: /^Proposed ticket/ }),
    ).toBeNull(),
  );
  // No workflow was saved, so the workflow list is not read again.
  expect(handlers.onSaved).not.toHaveBeenCalled();
  expect(e.calls.saveWorkflow).not.toHaveBeenCalled();
  expect(e.calls.resolveProposal).not.toHaveBeenCalled();
});

it("shows the engine's words when a ticket cannot be filed, and keeps it", async () => {
  const e = engine({ proposals: [ticket()] });
  e.calls.acceptTicketProposal.mockRejectedValue(
    new EngineError("not_found", "proposal 8 is not open", 404),
  );
  open(e);
  const proposed = await offered();
  await userEvent.click(
    within(proposed).getByRole("button", { name: "Open issue" }),
  );
  expect(await within(proposed).findByRole("alert")).toHaveTextContent(
    "proposal 8 is not open",
  );
  expect(
    within(proposed).getByRole("button", { name: "Open issue" }),
  ).toBeEnabled();
});

it("discards a ticket without opening an issue, and keeps Open issue off for a person who cannot run", async () => {
  const e = engine({ proposals: [ticket()] });
  open(e, { canRun: false });
  const proposed = await offered();
  expect(
    within(proposed).getByRole("button", { name: "Open issue" }),
  ).toBeDisabled();
  await userEvent.click(
    within(proposed).getByRole("button", { name: "Discard" }),
  );
  await vi.waitFor(() =>
    expect(e.calls.resolveProposal).toHaveBeenCalledWith(8n, false),
  );
  expect(e.calls.acceptTicketProposal).not.toHaveBeenCalled();
});

it("offers no Apply to a person who cannot run", async () => {
  const e = engine({ proposals: [proposal()] });
  open(e, { canRun: false });
  const proposed = await card();
  expect(
    within(proposed).getByRole("button", { name: "Apply" }),
  ).toBeDisabled();
});

it("follows the log from the saved cursor, so a result that arrived during a dropped poll still shows", async () => {
  const e = engine();
  const handlers = open(e, { restored: running() });
  // The panel was closed while the job ran: it follows from where it left off.
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  expect(e.polls[0]?.after).toBe(7n);
  expect(await screen.findByText("Working…")).toBeVisible();

  // The connection drops, and the result is stored meanwhile.
  e.offer([proposal()]);
  e.polls[0]?.drop();
  await vi.waitFor(() => expect(e.polls).toHaveLength(2));
  // It tries again from the same place, not from the start and not from the head.
  expect(e.polls[1]?.after).toBe(7n);
  e.polls[1]?.answer([
    event(8n, "job.result", {
      job_id: "job-1",
      state: "done",
      message: "I propose one new stage.",
      proposal_id: 5,
    }),
  ]);

  expect(await card()).toBeVisible();
  expect(await screen.findByText("Ready")).toBeVisible();
  expect(lastSession(handlers)).toEqual(
    expect.objectContaining({ job: undefined, cursor: 8n, root: "root-1" }),
  );
});

it("resumes a reopened panel from the cursor it saved", async () => {
  const e = engine();
  const first = open(e, { restored: running({ cursor: 7n }) });
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  // Events the panel does not care about move the cursor on.
  e.polls[0]?.answer([event(9n, "card.updated", { title: "x" })]);
  await vi.waitFor(() => expect(lastSession(first).cursor).toBe(9n));
  cleanup();

  const again = open(e, { restored: lastSession(first) });
  await vi.waitFor(() => expect(e.polls.at(-1)?.after).toBe(9n));
  e.polls.at(-1)?.answer([
    event(11n, "job.result", {
      job_id: "job-1",
      state: "done",
      message: "ok",
    }),
  ]);
  expect(await screen.findByText("Ready")).toBeVisible();
  expect(lastSession(again).job).toBeUndefined();
});

it("tells the person why a job ended without an answer", async () => {
  const e = engine();
  open(e, { restored: running() });
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  e.polls[0]?.answer([
    event(8n, "job.result", {
      job_id: "job-1",
      state: "failed",
      reason: "the assistant's agent did not report in time",
    }),
    // Another person's job is not this one.
    event(9n, "job.result", { job_id: "job-9", state: "done" }),
  ]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The assistant did not answer: the assistant's agent did not report in time.",
  );
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
});

it("calls CancelJob when Stop is pressed, and keeps the thread", async () => {
  const e = engine();
  const handlers = open(e, { restored: running() });
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));

  await vi.waitFor(() =>
    expect(e.calls.cancelJob).toHaveBeenCalledWith("job-1"),
  );
  expect(e.calls.cancelJob).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Ready")).toBeVisible();
  expect(lastSession(handlers)).toEqual(
    expect.objectContaining({ job: undefined, root: "root-1" }),
  );
  expect(screen.getByTestId("thread")).toHaveTextContent("root-1");
});

it("shows the engine's words when Stop fails, and the job keeps running", async () => {
  const e = engine();
  e.calls.cancelJob.mockRejectedValue(new Error("only the asker may cancel"));
  open(e, { restored: running() });
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "only the asker may cancel",
  );
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
});

it("starts a job from a starter prompt, shows the thread once the job names its root, and continues it", async () => {
  const e = engine();
  const handlers = open(e);
  expect(await screen.findByText("What can I help with?")).toBeVisible();
  expect(screen.getByText("I can see what you have open.")).toBeVisible();
  for (const prompt of [
    "Why did this run fail?",
    "Change the open workflow",
    "Summarize what is on the board",
  ])
    expect(screen.getByText(prompt)).toBeVisible();

  await userEvent.click(
    screen.getByRole("button", { name: "Ask Why did this run fail?" }),
  );
  // A new thread: no root is sent, and the log is followed from before the job started.
  await vi.waitFor(() =>
    expect(e.calls.startChat).toHaveBeenCalledWith(
      "Why did this run fail?",
      "",
    ),
  );
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  expect(e.polls[0]?.after).toBe(HEAD);
  expect(await screen.findByText("Working…")).toBeVisible();
  expect(screen.queryByTestId("thread")).toBeNull();

  e.polls[0]?.answer([
    event(11n, "job.started", { job_id: "job-1", root_event_id: "root-9" }),
  ]);
  expect(await screen.findByTestId("thread")).toHaveTextContent("root-9");
  expect(screen.getByTestId("thread")).toHaveAttribute("data-channel", CHANNEL);
  // One job runs in a thread at a time.
  expect(
    screen.getByRole("textbox", { name: "Ask anything..." }),
  ).toBeDisabled();

  await vi.waitFor(() => expect(e.polls).toHaveLength(2));
  e.polls[1]?.answer([
    event(12n, "job.result", { job_id: "job-1", state: "done", message: "x" }),
  ]);
  const box = await screen.findByRole("textbox", { name: "Ask anything..." });
  await vi.waitFor(() => expect(box).toBeEnabled());
  expect(lastSession(handlers)).toEqual(
    expect.objectContaining({ root: "root-9", job: undefined, cursor: 12n }),
  );

  e.calls.startChat.mockResolvedValue(
    create(StartJobResponseSchema, { jobId: "job-2" }),
  );
  await userEvent.type(box, "And the one before?");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  // A later turn names the thread's root.
  await vi.waitFor(() =>
    expect(e.calls.startChat).toHaveBeenLastCalledWith(
      "And the one before?",
      "root-9",
    ),
  );
});

it("shows the engine's words when a job cannot start, and keeps what was typed", async () => {
  const e = engine();
  e.calls.startChat.mockRejectedValue(
    new EngineError(
      "failed_precondition",
      "the assistant is still working in that thread; wait for it, or cancel it",
      412,
    ),
  );
  open(e);
  const box = await screen.findByRole("textbox", { name: "Ask anything..." });
  await userEvent.type(box, "Hello");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the assistant is still working in that thread",
  );
  expect(box).toHaveValue("Hello");
  expect(e.polls).toHaveLength(0);
});

it("says so when no assistant agent is chosen, and offers no way to ask", async () => {
  const e = engine({ agent: "" });
  open(e);
  expect(await screen.findByText("No assistant agent")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Ask anything..." })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Ask / })).toBeNull();
});

it("tells an admin where to choose the assistant agent, and anyone else to ask one", async () => {
  open(engine({ agent: "" }), { isAdmin: true });
  expect(
    await screen.findByText("Choose one under Assistant agent in Settings."),
  ).toBeVisible();
  cleanup();
  open(engine({ agent: "" }));
  expect(
    await screen.findByText(
      "An admin chooses the assistant agent in Settings.",
    ),
  ).toBeVisible();
});

it("shows why the settings could not be read and reads them again on Retry", async () => {
  const e = engine();
  e.calls.getCommunitySettings.mockRejectedValueOnce(
    new EngineError("unavailable", "Beehive is down", 503),
  );
  open(e);
  expect(await screen.findByRole("alert")).toHaveTextContent("Beehive is down");
  expect(screen.queryByText("What can I help with?")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("What can I help with?")).toBeVisible();
  expect(e.calls.getCommunitySettings).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

/** A relay whose channel list has not answered, so the thread cannot be shown yet. */
function waitingRelay(): RelayData {
  const relay = fakeRelay([{ id: CHANNEL, name: "updates" }]);
  const snapshot = relay.snapshot() as unknown as {
    session: { channels: { list: () => { status: string } } };
  };
  const loading = { status: "loading" };
  snapshot.session.channels.list = () => loading;
  return relay;
}

it("says it is connecting while the channel list has not answered", async () => {
  open(engine(), {
    restored: running({ job: undefined }),
    relay: waitingRelay(),
  });
  expect(await screen.findByText("Connecting to the community…")).toBeVisible();
  expect(screen.queryByTestId("thread")).toBeNull();
});

it("says so when the person is not in the channel the assistant answers in", async () => {
  open(engine(), {
    restored: running({ job: undefined }),
    relay: fakeRelay([]),
  });
  expect(await screen.findByText("No access to the channel")).toBeVisible();
  expect(screen.queryByTestId("thread")).toBeNull();
});

it("pauses when updates cannot be followed and follows again from the saved cursor on Retry", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const e = engine();
  const handlers = open(e, { restored: running({ cursor: 7n }) });
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  // A failure retrying cannot cure ends the follow and says why.
  e.polls[0]?.drop("permission_denied");
  expect(await screen.findByText(/^Live updates paused/)).toBeVisible();
  expect(e.polls).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(e.polls).toHaveLength(2));
  expect(e.polls[1]?.after).toBe(7n);
  expect(screen.queryByText(/^Live updates paused/)).toBeNull();
  e.polls[1]?.answer([
    event(8n, "job.result", { job_id: "job-1", state: "done" }),
  ]);
  expect(await screen.findByText("Ready")).toBeVisible();
  expect(lastSession(handlers).job).toBeUndefined();
});

it("keeps the proposal off the list but tells the person when it could not be read after the job offered it", async () => {
  const e = engine();
  open(e, { restored: running() });
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  e.calls.listProposals.mockRejectedValueOnce(
    new EngineError("unavailable", "Beehive is down", 503),
  );
  e.polls[0]?.answer([
    event(8n, "job.result", {
      job_id: "job-1",
      state: "done",
      proposal_id: 5,
    }),
  ]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The assistant offered a change, but it could not be loaded. Beehive is down",
  );
});

it("ignores a second Stop while the first is in flight, and keeps a newer job a late cancel would have cleared", async () => {
  const e = engine();
  let release: () => void = () => {};
  e.calls.cancelJob.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({});
      }),
  );
  const handlers = open(e, { restored: running() });
  await vi.waitFor(() => expect(e.polls).toHaveLength(1));
  const stop = screen.getByRole("button", { name: "Stop" });
  await userEvent.click(stop);
  await vi.waitFor(() => expect(e.calls.cancelJob).toHaveBeenCalledTimes(1));
  // While it is in flight Stop and the box are off, so nothing else can start or stop.
  expect(stop).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Ask anything..." }),
  ).toBeDisabled();

  // The job's own result arrives first, so the cancel has nothing left to clear.
  e.polls[0]?.answer([
    event(8n, "job.result", { job_id: "job-1", state: "done" }),
  ]);
  await vi.waitFor(() => expect(lastSession(handlers).job).toBeUndefined());
  release();
  await vi.waitFor(() => expect(stop).toBeDisabled());
  expect(e.calls.cancelJob).toHaveBeenCalledTimes(1);
  expect(lastSession(handlers)).toEqual(
    expect.objectContaining({ job: undefined, cursor: 8n }),
  );
});

it("starts a new thread with New, and closes with Done", async () => {
  const e = engine();
  const handlers = open(e, { restored: running({ job: undefined }) });
  await screen.findByTestId("thread");
  await userEvent.click(screen.getByRole("button", { name: "New" }));
  expect(await screen.findByText("What can I help with?")).toBeVisible();
  expect(lastSession(handlers)).toEqual(idle);
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});
