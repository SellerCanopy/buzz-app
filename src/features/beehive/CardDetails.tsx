import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { repoOf } from "./boardModel";
import { canMerge, isWebUrl } from "./cardActions";
import type { Card } from "./gen/kiln/engine/v1/engine_pb";
import { stateLabel } from "./labels";

/** Where a pull request stands: a draft that is still open says so. */
export function pullState(state: string, draft: boolean): string {
  return draft && state === "open" ? "draft" : state;
}

/**
 * What a card is made of: its facts, then the two things a person does to the card as a whole,
 * merging its pull request and setting it aside. Both buttons are there only for a person who
 * can run.
 */
export function Details({
  card,
  canRun = false,
  pending = false,
  onMerge,
  onArchive,
}: {
  card: Card;
  canRun?: boolean;
  /** An action is running, so the buttons wait. */
  pending?: boolean;
  onMerge?(): void;
  onArchive?(): void;
}) {
  const pull = card.pullRequest;
  const repo = repoOf(card);
  return (
    <div className="beehive-details">
      <dl className="beehive-facts">
        <div>
          <dt className="text-label text-subtle">State</dt>
          <dd>{card.archived ? "Archived" : stateLabel(card)}</dd>
        </div>
        {card.workflow && (
          <div>
            <dt className="text-label text-subtle">Workflow</dt>
            <dd>{card.workflow}</dd>
          </div>
        )}
        {repo && (
          <div>
            <dt className="text-label text-subtle">Repository</dt>
            <dd>{repo}</dd>
          </div>
        )}
        {card.branch && (
          <div>
            <dt className="text-label text-subtle">Branch</dt>
            <dd>
              <code>{card.branch}</code>
            </dd>
          </div>
        )}
        {pull && (
          <div>
            <dt className="text-label text-subtle">Pull request</dt>
            <dd>
              {isWebUrl(pull.url) ? (
                <Button
                  variant="link"
                  size="text"
                  role="link"
                  nativeButton={false}
                  render={
                    <a href={pull.url} target="_blank" rel="noreferrer" />
                  }
                >
                  {`#${pull.number}`}
                </Button>
              ) : (
                `#${pull.number}`
              )}
              {` ${pullState(pull.state, pull.draft)}`}
              {pull.checks && ` · checks ${pull.checks}`}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-label text-subtle">Auto mode</dt>
          <dd>
            {card.autoMode ? "On" : "Off"}
            <span className="text-body-sm text-subtle">
              {" "}
              Runs every stage without stopping for approvals.
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-label text-subtle">Description</dt>
          <dd className="beehive-description">
            {card.body || "No description."}
          </dd>
        </div>
      </dl>
      {canRun && canMerge(card) && (
        <PreferenceRow
          title="Merge"
          subtitle="Beehive checks the pull request once more, then merges it."
          trailing={
            <Button variant="prominent" disabled={pending} onClick={onMerge}>
              Merge pull request
            </Button>
          }
        />
      )}
      {canRun && (
        <PreferenceRow
          title={card.archived ? "Restore card" : "Archive card"}
          subtitle={
            card.archived
              ? "Brings the card back to the board."
              : "Hides the card from the board. You can restore it from Archived."
          }
          trailing={
            <Button loading={pending} disabled={pending} onClick={onArchive}>
              {card.archived ? "Restore" : "Archive"}
            </Button>
          }
        />
      )}
    </div>
  );
}
