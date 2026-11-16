import type { Chip } from "./boardModel";

/**
 * Every stage of the card's workflow in order, each with how the run stands in it, and a line
 * under it naming the stage the card is at.
 */
export function StageStrip({
  stages,
  caption,
}: {
  stages: Chip[];
  /** For example `plan_review, needs you. Step 2 of 6`. */
  caption: string | undefined;
}) {
  if (stages.length === 0) return null;
  return (
    <div className="beehive-strip">
      <ol className="beehive-chips" aria-label="Stages of the run">
        {stages.map((chip) => (
          <li
            key={chip.stage}
            className="beehive-chip text-body-sm"
            data-status={chip.status}
          >
            {chip.stage}
            <span className="sr-only">{`, ${chip.status}`}</span>
          </li>
        ))}
      </ol>
      {caption && <p className="text-body-sm text-subtle">{caption}</p>}
    </div>
  );
}
