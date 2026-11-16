import { useMemo, useState } from "react";
import { HexagonIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Header } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  NO_FILTERS,
  passes,
  latestRuns,
  waitingByCard,
  type Lane,
} from "./boardModel";
import { BoardFilters } from "./BoardFilters";
import { ArchivedRows, Lanes, type TileActions } from "./CardList";
import type { Client } from "./engine/client";
import { useLive } from "./engine/useLive";
import { errorMessage } from "./engine/transport";
import type { InboxItem } from "./gen/kiln/engine/v1/engine_pb";
import { MoveMenu } from "./MoveMenu";

/**
 * The Board view: the cards in four lanes, or the archive, with the search and filters, the
 * select mode and the actions a tile offers. It owns the read of the cards and the event log,
 * so they run only while the Board is mounted. A card opens on its own page.
 */
export function Board({
  client,
  canRun,
  archived,
  onArchived,
  waiting,
  onOpen,
  onNew,
  onNewFromIssue,
  onAskAssistant,
  onOpenNeedsYou,
}: {
  client: Client;
  canRun: boolean;
  archived: boolean;
  onArchived(archived: boolean): void;
  /** The open items of the inbox, once it has been read. */
  waiting: InboxItem[];
  onOpen(card: string): void;
  onNew(): void;
  onNewFromIssue(): void;
  onAskAssistant(): void;
  onOpenNeedsYou(): void;
}) {
  const { live, retry, refresh } = useLive(client);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [collapsed, setCollapsed] = useState<ReadonlySet<Lane>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const ready = live.status === "ready" ? live : undefined;
  const board = ready?.cards ?? [];
  const archive = ready?.archived ?? [];
  const list = archived ? archive : board;
  const shown = list.filter((card) => passes(card, filters));
  const runs = useMemo(
    () => (ready?.runs ? latestRuns(ready.runs) : undefined),
    [ready?.runs],
  );
  const byCard = useMemo(() => waitingByCard(waiting), [waiting]);
  const needing = board.filter((card) => byCard.has(card.id));
  // A card that left the board while selected (archived, say) is no longer chosen.
  const chosen = board.filter((card) => selected.has(card.id)).map((c) => c.id);
  const workflows = ready?.workflows;
  const problem =
    live.status === "error" ? live.message : (ready?.paused ?? ready?.stale);

  /** Runs one action. Only one runs at a time; the engine's refusal is shown word for word. */
  const act = async (task: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setActionError(undefined);
    try {
      await task();
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const actions: TileActions = {
    start: (card) => void act(() => client.startRun(card.id)),
    retry: (run) => void act(() => client.retryRun(run.id)),
    restore: (card) => void act(() => client.restoreCard(card.id)),
    move: (card, workflow) =>
      void act(() => client.setCardWorkflow([{ cardId: card.id, workflow }])),
  };

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const moveSelected = async (workflow: string) => {
    const moves = chosen.map((cardId) => ({ cardId, workflow }));
    if (await act(() => client.setCardWorkflow(moves))) setSelected(new Set());
  };
  const archiveSelected = async () => {
    if (await act(() => client.archiveCards(chosen))) setSelected(new Set());
  };

  const empty = ready && board.length === 0 && archive.length === 0;

  return (
    <>
      <Header
        title="Board"
        actions={
          <>
            <Button onClick={refresh}>Refresh</Button>
            {canRun && !archived && (
              <Button
                aria-pressed={selecting}
                onClick={() =>
                  selecting ? stopSelecting() : setSelecting(true)
                }
              >
                Select
              </Button>
            )}
            {canRun && <Button onClick={onNewFromIssue}>From an issue</Button>}
            <Button onClick={onAskAssistant}>Ask the assistant</Button>
            {canRun && (
              <Button variant="prominent" onClick={onNew}>
                New card
              </Button>
            )}
          </>
        }
      />
      {needing.length > 0 && (
        <section className="beehive-notice" aria-label="Cards that need you">
          <div>
            <p className="text-label">
              {needing.length === 1
                ? "1 card needs you"
                : `${needing.length} cards need you`}
            </p>
            <p className="text-body-sm text-subtle">
              {needing
                .flatMap((card) => byCard.get(card.id) ?? [])
                .map((item) => item.title || item.cardTitle)
                .join(" · ")}
            </p>
          </div>
          <Button size="sm" onClick={onOpenNeedsYou}>
            Open Needs you
          </Button>
        </section>
      )}
      {ready && !empty && (
        <BoardFilters
          cards={list}
          archivedCount={archive.length}
          archived={archived}
          filters={filters}
          onFilters={setFilters}
          onArchived={onArchived}
        />
      )}
      {selecting && !archived && (
        <div
          className="beehive-select-bar"
          role="toolbar"
          aria-label="Selected cards"
        >
          <span>{`${chosen.length} selected`}</span>
          <MoveMenu
            label="Move to"
            workflows={workflows ?? []}
            disabled={busy || chosen.length === 0}
            onMove={(workflow) => void moveSelected(workflow)}
            onArchive={() => void archiveSelected()}
          />
          <Button
            disabled={chosen.length === 0}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-danger">
          {actionError}
        </p>
      )}
      <LoadingRegion
        pending={live.status === "loading"}
        label="Loading cards…"
        feedback={
          problem ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {problem}
              </p>
              <Button onClick={retry}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {ready && archived && archive.length === 0 && (
          <EmptyState
            icon={<HexagonIcon size="1.5rem" />}
            title="Nothing archived"
            description="Cards you archive are kept here and can be restored."
          />
        )}
        {ready && archived && archive.length > 0 && (
          <ArchivedRows
            cards={shown}
            canRun={canRun}
            busy={busy}
            actions={actions}
            onOpen={onOpen}
          />
        )}
        {ready && !archived && (
          <Lanes
            cards={shown}
            collapsed={collapsed}
            onCollapse={(lane) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (!next.delete(lane)) next.add(lane);
                return next;
              })
            }
            selecting={selecting}
            selected={selected}
            onSelect={(card, on) =>
              setSelected((current) => {
                const next = new Set(current);
                if (on) next.add(card);
                else next.delete(card);
                return next;
              })
            }
            runs={runs}
            workflows={workflows}
            waiting={byCard}
            canRun={canRun}
            busy={busy}
            actions={actions}
            onOpen={onOpen}
          />
        )}
      </LoadingRegion>
    </>
  );
}
