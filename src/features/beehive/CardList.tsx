import {
  CaretDownIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import {
  LANES,
  chipsOf,
  issueOf,
  laneOf,
  progressOf,
  statusOf,
  type Lane,
} from "./boardModel";
import type {
  Card,
  InboxItem,
  Run,
  Workflow,
} from "./gen/kiln/engine/v1/engine_pb";
import { canMove, canRetry, canStart } from "./cardActions";
import { MoveMenu } from "./MoveMenu";

/** What a person can do to a card from the board, each as one call to the engine. */
export type TileActions = {
  start(card: Card): void;
  retry(run: Run): void;
  restore(card: Card): void;
  /** An empty workflow is Backlog. */
  move(card: Card, workflow: string): void;
};

/** What a tile and a row need beyond the card itself. */
type Context = {
  /** The newest run of each card, or unset when the runs could not be read. */
  runs: Map<string, Run> | undefined;
  workflows: Workflow[] | undefined;
  waiting: Map<string, InboxItem[]>;
  canRun: boolean;
  /** An action is running, so the buttons wait. */
  busy: boolean;
  actions: TileActions;
  onOpen(card: string): void;
};

/**
 * The four lanes of the board. A lane with no cards says so, and a lane folds away to its
 * heading. In select mode each tile has a checkbox.
 */
export function Lanes({
  cards,
  collapsed,
  onCollapse,
  selecting,
  selected,
  onSelect,
  ...context
}: {
  cards: Card[];
  collapsed: ReadonlySet<Lane>;
  onCollapse(lane: Lane): void;
  selecting: boolean;
  selected: ReadonlySet<string>;
  onSelect(card: string, on: boolean): void;
} & Context) {
  return (
    <div className="beehive-lanes">
      {LANES.map((lane) => {
        const inLane = cards.filter((card) => laneOf(card) === lane.key);
        const folded = collapsed.has(lane.key);
        return (
          <section
            key={lane.key}
            aria-label={lane.label}
            className="beehive-lane"
          >
            <div className="beehive-lane-head">
              <IconButton
                aria-label={`${folded ? "Expand" : "Collapse"} ${lane.label}`}
                aria-expanded={!folded}
                icon={
                  folded ? (
                    <CaretRightIcon size="1rem" />
                  ) : (
                    <CaretDownIcon size="1rem" />
                  )
                }
                onClick={() => onCollapse(lane.key)}
              />
              <InlineHeader title={lane.label} />
              <span
                className="text-body-sm text-subtle"
                role="img"
                aria-label={`${inLane.length} ${inLane.length === 1 ? "card" : "cards"}`}
              >
                {inLane.length}
              </span>
            </div>
            {!folded &&
              (inLane.length === 0 ? (
                <p className="beehive-lane-empty text-body-sm text-subtle">
                  No cards
                </p>
              ) : (
                <ul className="beehive-cards">
                  {inLane.map((card) => (
                    <Tile
                      key={card.id}
                      card={card}
                      selecting={selecting}
                      selected={selected.has(card.id)}
                      onSelect={(on) => onSelect(card.id, on)}
                      {...context}
                    />
                  ))}
                </ul>
              ))}
          </section>
        );
      })}
    </div>
  );
}

function Tile({
  card,
  selecting,
  selected,
  onSelect,
  runs,
  workflows,
  waiting,
  canRun,
  busy,
  actions,
  onOpen,
}: {
  card: Card;
  selecting: boolean;
  selected: boolean;
  onSelect(on: boolean): void;
} & Context) {
  const run = runs?.get(card.id);
  const workflow = workflows?.find((item) => item.name === card.workflow);
  const items = waiting.get(card.id) ?? [];
  const status = statusOf(card, items);
  const progress = progressOf(card, run, workflow);
  const chips = chipsOf(run, workflow);
  const issue = issueOf(card);
  const review = items.some((item) => item.kind === "approval");
  const answer = items.some((item) => item.kind === "question");
  const movable = canRun && !!workflows && !!runs && canMove(card, run);
  return (
    <li
      className="beehive-tile"
      data-selected={selected || undefined}
      data-danger={status.tone === "danger" || undefined}
    >
      <div className="beehive-tile-head">
        {selecting && (
          <Checkbox
            size="sm"
            checked={selected}
            onCheckedChange={onSelect}
            label={<span className="sr-only">{`Select ${card.title}`}</span>}
          />
        )}
        <div className="beehive-tile-title">
          <Button variant="link" size="text" onClick={() => onOpen(card.id)}>
            {card.title}
          </Button>
        </div>
      </div>
      <p className="beehive-tile-meta text-body-sm text-subtle">
        <span className="beehive-tag">{card.workflow || "No workflow"}</span>
        <span>{issue || "No repo"}</span>
      </p>
      {chips.length > 0 ? (
        <ul className="beehive-chips" aria-label="Steps">
          {chips.map((chip) => (
            <li
              key={chip.stage}
              className="beehive-chip text-body-sm"
              data-status={chip.status}
            >
              {chip.stage}
              <span className="sr-only">{`, ${chip.status}`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body-sm text-subtle">no steps</p>
      )}
      <div className="beehive-tile-progress">
        {progress ? (
          <>
            <progress
              className="beehive-progress"
              data-tone={status.tone}
              aria-label={`${card.title} progress`}
              max={progress.total}
              value={progress.done}
            />
            <span className="text-body-sm text-subtle">{`${progress.done} of ${progress.total}`}</span>
          </>
        ) : (
          <span className="text-body-sm text-subtle">not started</span>
        )}
      </div>
      <div className="beehive-tile-foot">
        <span className="beehive-status text-body-sm" data-tone={status.tone}>
          {status.label}
        </span>
        <div className="beehive-tile-actions">
          {review && (
            <Button
              size="sm"
              variant="prominent"
              onClick={() => onOpen(card.id)}
            >
              Review
            </Button>
          )}
          {answer && (
            <Button
              size="sm"
              variant="prominent"
              onClick={() => onOpen(card.id)}
            >
              Answer
            </Button>
          )}
          {canRun && canRetry(card, run) && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => actions.retry(run)}
            >
              Retry run
            </Button>
          )}
          {canRun && canStart(card) && (
            <Button
              size="sm"
              disabled={busy}
              aria-label={`Start run on ${card.title}`}
              onClick={() => actions.start(card)}
            >
              Start run
            </Button>
          )}
          {movable && (
            <MoveMenu
              label="Move"
              cardLabel={`Move ${card.title}`}
              workflows={workflows}
              current={card.workflow}
              disabled={busy}
              onMove={(next) => actions.move(card, next)}
            />
          )}
        </div>
      </div>
    </li>
  );
}

/** The archive: one row for each card set aside, with the way to bring it back. */
export function ArchivedRows({
  cards,
  canRun,
  busy,
  actions,
  onOpen,
}: {
  cards: Card[];
  canRun: boolean;
  busy: boolean;
  actions: Pick<TileActions, "restore">;
  onOpen(card: string): void;
}) {
  return (
    <ul className="beehive-cards" aria-label="Archived cards">
      {cards.map((card) => (
        <li key={card.id}>
          <PreferenceRow
            title={
              <Button
                variant="link"
                size="text"
                onClick={() => onOpen(card.id)}
              >
                {card.title}
              </Button>
            }
            subtitle={`${card.workflow || "No workflow"}, ${issueOf(card) || "No repo"}`}
            trailing={
              canRun ? (
                <Button
                  size="sm"
                  disabled={busy}
                  aria-label={`${card.workflow ? "Restore" : "Back to Backlog"} ${card.title}`}
                  onClick={() => actions.restore(card)}
                >
                  {card.workflow ? "Restore" : "Back to Backlog"}
                </Button>
              ) : undefined
            }
          />
        </li>
      ))}
    </ul>
  );
}
