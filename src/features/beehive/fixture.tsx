import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../shared/styles/globals.css";
import { Button } from "../../shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { BeehivePage } from "./BeehivePage";
import { fakeRelay } from "./fake-relay";
import { PAGE_ID, PLUGIN_ID } from "./routes";
import { createClient } from "./engine/client";
import { createSession } from "./engine/session";
import {
  EngineError,
  TOKEN_PATH,
  type Carrier,
  webCarrier,
} from "./engine/transport";
import { provideWebSigner, webAuthorization } from "./engine/web-signer";

// An offline Beehive that keeps its cards and event log in memory.
// `listCardsFailures` is how many ListCards calls fail before one succeeds, and
// `role` is what WhoAmI reports; a journey sets both with `addInitScript`.
type Fixture = {
  listCardsFailures: number;
  role: string;
  calls: string[];
  /** Another person adds a card: it reaches the engine, not this page's client. */
  externalCreate(title: string, workflow?: string): Promise<unknown>;
  /** The agent of the card's first stage reports passed; the next stage is held. */
  externalPass(cardId: string): Promise<unknown>;
  /** A stage opens an approval and the card waits for a person. */
  externalGate(title: string): Promise<{ id: string; itemId: string }>;
};
const fixture: Fixture = Object.assign(
  {
    listCardsFailures: 0,
    role: "run",
    calls: [] as string[],
    externalCreate: (title: string, workflow = "") =>
      handle("CreateCard", { title, workflow }),
    externalPass: (cardId: string) => handle("StageDone", { cardId }),
    externalGate: (title: string) => openGate(title),
  },
  (window as unknown as { beehiveFixture?: Partial<Fixture> }).beehiveFixture,
);
Object.assign(window, { beehiveFixture: fixture });

type FakeCard = {
  id: string;
  title: string;
  workflow: string;
  state: string;
  archived: boolean;
  body: string;
};
type FakeStep = {
  stage: string;
  visit: number;
  round: number;
  result?: string;
  routedTo?: string;
  held?: boolean;
};
type FakeRun = {
  id: string;
  cardId: string;
  stageId: string;
  state: string;
  steps: FakeStep[];
};
type FakeEvent = {
  seq: string;
  type: string;
  cardId: string;
  payloadJson: string;
};
type FakeThread = {
  stage: string;
  visit: number;
  rootEventId: string;
  agentPubkey: string;
  channelId: string;
};
const cards: FakeCard[] = [];
const runs = new Map<string, FakeRun>();
// The thread each stage started in the update channel, in the order they began.
const threads = new Map<string, FakeThread[]>();
const postThread = (cardId: string, stage: string) =>
  threads.set(cardId, [
    ...(threads.get(cardId) ?? []),
    {
      stage,
      visit: 1,
      rootEventId: (threads.get(cardId)?.length ?? 0)
        .toString(16)
        .padStart(64, "e"),
      agentPubkey: "a".repeat(64),
      channelId: JSON.parse(updateChannel) as string,
    },
  ]);
// What each card's stages saved, keyed by card id, every version oldest first.
const saved = new Map<string, Record<string, unknown>[]>();
const log: FakeEvent[] = [];
const waiters = new Set<() => void>();

type FakeItem = {
  id: string;
  kind: string;
  cardId: string;
  cardTitle: string;
  state: string;
  title: string;
  stage: string;
  visit: number;
  choices: string[];
  detailJson: string;
};
type FakeActivity = {
  seq: string;
  key: string;
  cardId: string;
  type: string;
  summary: string;
  detail: string;
  at: string;
  author: { kind: string; id?: string };
};
const inbox: FakeItem[] = [];
const activity: FakeActivity[] = [];
// A person in the fixture is this key; the agent and the engine have their own labels.
const PERSON = "b".repeat(64);

function publish(type: string, card: FakeCard) {
  log.push({
    seq: String(log.length + 1),
    type,
    cardId: card.id,
    payloadJson: JSON.stringify({
      title: card.title,
      workflow: card.workflow,
      state: card.state,
    }),
  });
  for (const wake of [...waiters]) wake();
}
function publishItem(type: string, item: FakeItem) {
  log.push({
    seq: String(log.length + 1),
    type,
    cardId: item.cardId,
    payloadJson: JSON.stringify({ item: item.id, kind: item.kind }),
  });
  for (const wake of [...waiters]) wake();
}
function note(cardId: string, type: string, summary: string, detail = "") {
  activity.push({
    seq: String(activity.length + 1),
    key: `a${activity.length + 1}`,
    cardId,
    type,
    summary,
    detail,
    at: new Date(Date.UTC(2026, 10, 15, 9, activity.length)).toISOString(),
    author:
      type === "answer" ? { kind: "person", id: PERSON } : { kind: "kiln" },
  });
}
/** A card whose approval stage waits: what a person sees after an agent drafts a plan. */
async function openGate(title: string) {
  const card = (await handle("CreateCard", {
    title,
    workflow: "demo",
  })) as FakeCard;
  const real = find(card.id);
  real.state = "waiting";
  publish("card.state", real);
  const item: FakeItem = {
    id: crypto.randomUUID(),
    kind: "approval",
    cardId: real.id,
    cardTitle: title,
    state: "open",
    title: "Approve the plan",
    stage: "approve",
    visit: 1,
    choices: ["approve", "reject"],
    detailJson: JSON.stringify({ artifacts: ["plan"] }),
  };
  inbox.push(item);
  note(real.id, "note", "Waiting for approval of the plan");
  publishItem("inbox.opened", item);
  return { id: real.id, itemId: item.id };
}
const wire = (card: FakeCard, withBody = false) => ({
  ...card,
  body: withBody ? card.body : "",
});
const find = (id: unknown) => {
  const card = cards.find((c) => c.id === id);
  if (!card) throw new EngineError("not_found", "card does not exist", 404);
  return card;
};
const lastSeq = () => String(log.length);

// Channels the offline relay lists. The engine refuses `empty-room` the way it
// refuses a channel its own account has not joined.
const CHANNELS = [
  { id: "5f1c2d3e-0000-4000-8000-000000000001", name: "updates" },
  { id: "5f1c2d3e-0000-4000-8000-000000000002", name: "general" },
  { id: "5f1c2d3e-0000-4000-8000-000000000003", name: "empty-room" },
];
const NOT_JOINED = CHANNELS[2]?.id;
let updateChannel = "null";

// Two packages and a folder that did not load, to show what the page lists and
// reports. `broken` routes to a stage that does not exist.
const WORKFLOWS = [
  {
    name: "demo",
    version: "0.1.0",
    description: "A small workflow for trying Beehive.",
    builtin: true,
    ok: true,
    stages: [
      { id: "plan", name: "Plan", kind: "prompt", agent: "builder" },
      { id: "approve", name: "Approve", kind: "approval", pause: true },
    ],
  },
  {
    name: "broken",
    version: "1",
    ok: false,
    stages: [{ id: "build", name: "Build", kind: "prompt", agent: "builder" }],
  },
];
const CHECKS = [
  { name: "demo", path: "builtin/demo", findings: [] },
  {
    name: "broken",
    path: "workflows/broken",
    findings: [
      {
        path: "workflow.yaml:stages[0].on.passed",
        code: "route_target_unknown",
        severity: "error",
        message: "stage build routes passed to a stage that does not exist",
      },
    ],
  },
  {
    name: "",
    path: "workflows/nameless",
    findings: [
      {
        path: "kiln-package.yaml",
        code: "package_unreadable",
        severity: "error",
        message: "kiln-package.yaml has no name",
      },
    ],
  },
];

async function handle(
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (method) {
    case "ListCards":
      if (fixture.listCardsFailures > 0) {
        fixture.listCardsFailures -= 1;
        throw new EngineError("unavailable", "Beehive is not reachable", 0);
      }
      return {
        cards: cards
          .filter((c) => c.archived === Boolean(body.archived))
          .reverse()
          .map((c) => wire(c)),
        seq: lastSeq(),
      };
    case "WhoAmI":
      return { role: fixture.role };
    case "ListWorkflows":
      return { workflows: WORKFLOWS };
    case "CheckWorkflow":
      return { packages: CHECKS, ok: false };
    case "GetCard": {
      const card = find(body.cardId);
      return {
        ...wire(card, true),
        stageId: runs.get(card.id)?.stageId ?? "",
        stages: threads.get(card.id) ?? [],
      };
    }
    case "GetSettings":
      return {
        settings: [
          {
            key: "update_channel",
            valueJson: updateChannel,
            source: { layer: updateChannel === "null" ? "defaults" : "user" },
          },
        ],
      };
    case "SetSetting": {
      if (body.key !== "update_channel")
        throw new EngineError("invalid_argument", "unknown setting", 400);
      const next = String(body.valueJson ?? "");
      if (next && next === JSON.stringify(NOT_JOINED))
        throw new EngineError(
          "failed_precondition",
          "add the Beehive account to this channel, then save again",
          400,
        );
      updateChannel = next || "null";
      return { key: "update_channel", valueJson: updateChannel };
    }
    case "StartStage": {
      const card = find(body.cardId);
      if (updateChannel === "null")
        throw new EngineError(
          "failed_precondition",
          "choose an update channel in Beehive settings before starting a run",
          400,
        );
      card.state = "running";
      publish("card.state", card);
      // The demo workflow's first stage is plan.
      const run: FakeRun = {
        id: crypto.randomUUID(),
        cardId: card.id,
        stageId: "plan",
        state: "running",
        steps: [{ stage: "plan", visit: 1, round: 1 }],
      };
      runs.set(card.id, run);
      postThread(card.id, "plan");
      return run;
    }
    case "StageDone": {
      // The demo workflow holds the card before approve until a person resumes it.
      const card = find(body.cardId);
      const run = runs.get(card.id);
      if (run?.state !== "running")
        throw new EngineError(
          "failed_precondition",
          "no stage is running",
          400,
        );
      Object.assign(run.steps[0] as FakeStep, {
        result: "passed",
        routedTo: "approve",
      });
      // The first stage saved a document and a file before it reported.
      saved.set(card.id, [
        {
          name: "plan",
          version: 1,
          kind: "text",
          content: "Draft one",
          size: "9",
        },
        {
          name: "plan",
          version: 2,
          kind: "text",
          content: "Ship the board in two steps",
          size: "27",
        },
        {
          name: "sketch",
          version: 1,
          kind: "file",
          mediaType: "image/png",
          size: "2048",
          mediaRef: "https://relay.example.org/media/sketch.png",
        },
      ]);
      run.steps.push({ stage: "approve", visit: 1, round: 1, held: true });
      run.stageId = "approve";
      postThread(card.id, "approve");
      run.state = "paused";
      card.state = "waiting";
      publish("card.state", card);
      return run;
    }
    case "ListArtifacts": {
      const all = saved.get(String(body.cardId)) ?? [];
      const names = [...new Set(all.map((v) => String(v.name)))];
      return {
        artifacts: names.map((name) => {
          const last = all.filter((v) => v.name === name).at(-1);
          return { name, latest: last?.version, kind: last?.kind };
        }),
      };
    }
    case "ListArtifactVersions": {
      const all = saved.get(String(body.cardId)) ?? [];
      return {
        versions: all
          .filter((v) => v.name === body.name)
          .map((v) => ({ ...v, content: "" })),
      };
    }
    case "ReadArtifact": {
      const all = (saved.get(String(body.cardId)) ?? []).filter(
        (v) => v.name === body.name,
      );
      const found =
        all.find((v) => v.version === body.version) ?? all[all.length - 1];
      if (!found)
        throw new EngineError("not_found", "artifact does not exist", 404);
      return found;
    }
    case "ListRuns": {
      const run = runs.get(String(body.cardId));
      return { runs: run ? [run] : [], seq: lastSeq() };
    }
    case "ResumeCard": {
      const card = find(body.cardId);
      const run = runs.get(card.id);
      if (run?.state !== "paused")
        throw new EngineError(
          "failed_precondition",
          "the run is not held; only a paused card can be resumed",
          400,
        );
      run.state = "running";
      card.state = "running";
      publish("card.state", card);
      return run;
    }
    case "CreateCard": {
      const card: FakeCard = {
        id: crypto.randomUUID(),
        title: String(body.title ?? ""),
        workflow: String(body.workflow ?? ""),
        state: "idle",
        archived: false,
        body: String(body.description ?? ""),
      };
      cards.push(card);
      publish("card.created", card);
      return wire(card);
    }
    case "ArchiveCards":
      for (const id of (body.cardIds as string[]) ?? []) {
        const card = find(id);
        card.archived = true;
        publish("card.archived", card);
      }
      return {};
    case "RestoreCard": {
      const card = find(body.cardId);
      card.archived = false;
      card.workflow = "";
      publish("card.restored", card);
      return wire(card);
    }
    case "ListInbox":
      return {
        items: inbox.filter((item) => item.state === "open"),
        seq: lastSeq(),
      };
    case "AnswerInbox": {
      const item = inbox.find((i) => i.id === body.itemId);
      if (!item)
        throw new EngineError("not_found", "inbox item does not exist", 404);
      if (item.state !== "open")
        throw new EngineError(
          "failed_precondition",
          "this item was already answered",
          409,
        );
      const choice = String(body.choice ?? "");
      const text = String(body.text ?? "").trim();
      if (!item.choices.includes(choice))
        throw new EngineError(
          "invalid_argument",
          `${choice || "(empty)"} is not an answer this item takes`,
          400,
        );
      if (choice === "reject" && !text)
        throw new EngineError(
          "invalid_argument",
          "a reason is required to reject",
          400,
        );
      item.state = "resolved";
      const card = find(item.cardId);
      card.state = choice === "approve" ? "done" : "running";
      note(
        card.id,
        "answer",
        choice === "approve" ? "Approved the plan" : "Rejected the plan",
        text,
      );
      publishItem("inbox.resolved", item);
      publish("card.state", card);
      return {};
    }
    case "ListActivity":
      return {
        entries: activity.filter((e) => e.cardId === body.cardId),
        seq: lastSeq(),
      };
    case "GetUsage":
      return {
        runs: 7,
        endedRuns: 5,
        averageRunSeconds: "75",
        longestRunSeconds: "3700",
        weeks: [
          {
            starts: "2026-10-19",
            cardsCreatedByAgents: 0,
            runsStartedByAgents: 0,
          },
          {
            starts: "2026-10-26",
            cardsCreatedByAgents: 2,
            runsStartedByAgents: 1,
          },
          {
            starts: "2026-11-02",
            cardsCreatedByAgents: 3,
            runsStartedByAgents: 1,
          },
          {
            starts: "2026-11-09",
            cardsCreatedByAgents: 1,
            runsStartedByAgents: 4,
          },
        ],
      };
    case "PollEvents": {
      const after = Number(body.afterSeq ?? 0);
      // Park until a card changes, like the engine does; give up when abandoned.
      while (log.length <= after) {
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
          signal?.addEventListener("abort", () => {
            waiters.delete(wake);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return { events: log.slice(after), nextSeq: lastSeq() };
    }
    default:
      return {};
  }
}

const carrier: Carrier = {
  authorize: async () => "Nostr fixture",
  async post(path, body, opts, signal) {
    // Like fetch, a call that was abandoned before it started never happens.
    signal?.throwIfAborted();
    fixture.calls.push(
      `${path} ${opts.bearer ? `bearer ${opts.bearer}` : (opts.authorization ?? "")}`.trim(),
    );
    if (path === TOKEN_PATH)
      return { token: "fixture-token", expires_at: Date.now() / 1000 + 900 };
    return handle(
      path.slice(path.lastIndexOf("/") + 1),
      (body ?? {}) as Record<string, unknown>,
      signal,
    );
  },
};
// `?hive=<origin>` points the page at a real engine and signs with the fixed
// test key, for e2e/board.spec.mjs. It is never reachable from the app.
const hive = new URLSearchParams(location.search).get("hive");
if (hive) {
  const { testSigner } = await import("./e2e/signer");
  provideWebSigner(testSigner);
}
const client = createClient(
  createSession(
    hive ? webCarrier(hive, () => webAuthorization(hive)) : carrier,
  ),
);

// A stand-in for the shell's navigation, enough for Back, Forward and Close on a
// card. The real controller has its own tests; this only lets the page be driven.
type Entry = { id: string; target: OpenTarget };
const entry = (target: OpenTarget): Entry => ({
  id: crypto.randomUUID(),
  target,
});
const board: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: PLUGIN_ID,
  pageId: PAGE_ID,
};

const relay = fakeRelay(CHANNELS);

/** Stands in for the host's embedded thread, which needs a live relay session. */
function Thread({
  channelName,
  messageId,
}: {
  channelName: string;
  messageId: string;
}) {
  return (
    <section aria-label="Stage thread" data-root={messageId}>
      <p>{`Thread in #${channelName}`}</p>
      <p className="text-subtle" style={{ overflowWrap: "anywhere" }}>
        {messageId}
      </p>
    </section>
  );
}

function Fixture() {
  useKeyboardFocusVisibility();
  const [history, setHistory] = useState({ entries: [entry(board)], index: 0 });
  const current = history.entries[history.index] as Entry;
  const visit = useRef<{ id: string; abort: AbortController } | undefined>(
    undefined,
  );
  if (visit.current?.id !== current.id) {
    visit.current?.abort.abort();
    visit.current = { id: current.id, abort: new AbortController() };
  }
  const navigator = useMemo(
    () =>
      ({
        open: async (target: OpenTarget) => {
          setHistory((h) => ({
            entries: [...h.entries.slice(0, h.index + 1), entry(target)],
            index: h.index + 1,
          }));
          return { status: "opened" };
        },
        dismiss: (
          retire: (target: OpenTarget) => boolean,
          fallback: OpenTarget,
        ) =>
          setHistory((h) => {
            const shown = h.entries[h.index] as Entry;
            const kept = h.entries.filter((e) => !retire(e.target));
            if (!kept.length) return { entries: [entry(fallback)], index: 0 };
            const at = kept.indexOf(shown);
            if (at >= 0) return { entries: kept, index: at };
            const before = h.entries
              .slice(0, h.index)
              .filter((e) => kept.includes(e));
            return {
              entries: kept,
              index: Math.max(0, before.length - 1),
            };
          }),
      }) as unknown as Navigation,
    [],
  );
  const navigation = {
    entryId: current.id,
    target: current.target,
    signal: (visit.current as { abort: AbortController }).abort.signal,
  } as unknown as Parameters<typeof BeehivePage>[0]["navigation"];
  return (
    <main
      data-buzz-ui=""
      className="text-body"
      style={{ padding: 24, height: "100vh", boxSizing: "border-box" }}
    >
      <Button
        onClick={() => {
          document.documentElement.dataset.colorMode =
            document.documentElement.dataset.colorMode === "dark"
              ? "light"
              : "dark";
        }}
      >
        Toggle appearance
      </Button>
      <Button
        disabled={history.index === 0}
        onClick={() => setHistory((h) => ({ ...h, index: h.index - 1 }))}
      >
        Back
      </Button>
      <Button
        disabled={history.index >= history.entries.length - 1}
        onClick={() => setHistory((h) => ({ ...h, index: h.index + 1 }))}
      >
        Forward
      </Button>
      <div style={{ height: "calc(100% - 48px)", marginTop: 12 }}>
        <BeehivePage
          client={client}
          relay={relay}
          navigation={navigation}
          navigator={navigator}
          Thread={Thread as never}
        />
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
