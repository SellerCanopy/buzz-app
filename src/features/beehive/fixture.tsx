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
import { EngineError, type Carrier, webCarrier } from "./engine/transport";
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
};
const fixture: Fixture = Object.assign(
  {
    listCardsFailures: 0,
    role: "run",
    calls: [] as string[],
    externalCreate: (title: string, workflow = "") =>
      handle("CreateCard", { title, workflow }),
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
type FakeEvent = {
  seq: string;
  type: string;
  cardId: string;
  payloadJson: string;
};
const cards: FakeCard[] = [];
const log: FakeEvent[] = [];
const waiters = new Set<() => void>();

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
    case "GetCard":
      return wire(find(body.cardId), true);
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
      return { id: crypto.randomUUID(), cardId: card.id, state: "running" };
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
    if (path === "/auth/token")
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
