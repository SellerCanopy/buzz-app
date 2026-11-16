import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CopyIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { kindLabel, type DraftStage } from "./workflowDraft";

/** The line a stage's tag shows: the agent, the documents to approve, or what the job does. */
function tagOf(stage: DraftStage): string {
  switch (stage.kind) {
    case "prompt":
      return typeof stage.agent === "string" ? stage.agent : "";
    case "approval": {
      const approval = stage.approval as { artifacts?: unknown } | undefined;
      return Array.isArray(approval?.artifacts)
        ? approval.artifacts.join(", ")
        : "";
    }
    case "action":
      return typeof stage.action === "string"
        ? stage.action.replaceAll("_", " ")
        : "";
    default:
      return "";
  }
}

/** The colors of the arcs, by the result a route is taken on. */
export const RESULTS = [
  { result: "passed", label: "Passes" },
  { result: "needs_work", label: "Needs work" },
  { result: "failed", label: "Fails" },
  { result: "needs_input", label: "Needs input" },
] as const;

const NODE_WIDTH = 168;
const GAP = 48;
const PAD = 16;
const ARC_STEP = 18;

const centre = (index: number) =>
  PAD + index * (NODE_WIDTH + GAP) + NODE_WIDTH / 2;

type Arc = { from: number; to: number; result: string };

/** Every route that names another stage, with the result it is taken on. */
function arcsOf(stages: DraftStage[]): Arc[] {
  const arcs: Arc[] = [];
  stages.forEach((stage, from) => {
    const on = stage.on as Record<string, unknown> | undefined;
    if (!on) return;
    for (const [result, target] of Object.entries(on)) {
      const to = stages.findIndex((other) => other.id === target);
      if (to >= 0 && to !== from + 1) arcs.push({ from, to, result });
    }
  });
  return arcs;
}

/** How many problems the checks found in each stage, by severity. */
export type StageMarks = Map<number, "error" | "warning">;

/**
 * The stages of a workflow as a row of nodes, with an arc under them for each route that does
 * not go to the next stage. The selected stage shows the buttons that move, copy or remove it.
 * A card that passes a stage goes to the next one unless a route says otherwise.
 */
export function StageCanvas({
  stages,
  selected,
  marks,
  editable,
  onSelect,
  onMove,
  onDuplicate,
  onRemove,
}: {
  stages: DraftStage[];
  selected: number | undefined;
  marks: StageMarks;
  editable: boolean;
  onSelect(index: number): void;
  onMove(index: number, by: number): void;
  onDuplicate(index: number): void;
  onRemove(index: number): void;
}) {
  const arcs = arcsOf(stages);
  const depth = Math.max(0, ...arcs.map((a) => Math.abs(a.to - a.from)));
  const height = arcs.length ? 24 + depth * ARC_STEP : 0;
  const width =
    PAD * 2 + stages.length * NODE_WIDTH + (stages.length - 1) * GAP;
  return (
    <div className="wf-canvas">
      <ol className="wf-nodes" aria-label="Stages" style={{ minWidth: width }}>
        {stages.map((stage, index) => {
          const tag = tagOf(stage);
          const mark = marks.get(index);
          // Ids repeat while a draft is mid-edit, so the position is part of the key.
          const key = [index, stage.id].join(":");
          const label = String(stage.name || stage.id);
          return (
            <li
              key={key}
              className="wf-node"
              data-selected={selected === index ? "" : undefined}
              data-mark={mark}
              style={{ width: NODE_WIDTH }}
            >
              <SurfaceButton
                type="button"
                className="wf-node-main"
                aria-pressed={selected === index}
                aria-label={`${stage.id}, ${kindLabel(stage.kind)}${mark ? `, has ${mark === "error" ? "an error" : "a warning"}` : ""}`}
                onClick={() => onSelect(index)}
              >
                <span className="text-body-sm text-subtle">
                  {kindLabel(stage.kind)}
                </span>
                <span className="text-label">{label}</span>
                {tag && <span className="beehive-tag">{tag}</span>}
              </SurfaceButton>
              {selected === index && editable && (
                <div className="wf-node-tools">
                  <IconButton
                    aria-label="Move earlier"
                    icon={<ArrowLeftIcon size="1rem" />}
                    disabled={index === 0}
                    onClick={() => onMove(index, -1)}
                  />
                  <IconButton
                    aria-label="Move later"
                    icon={<ArrowRightIcon size="1rem" />}
                    disabled={index === stages.length - 1}
                    onClick={() => onMove(index, 1)}
                  />
                  <IconButton
                    aria-label="Duplicate stage"
                    icon={<CopyIcon size="1rem" />}
                    onClick={() => onDuplicate(index)}
                  />
                  <IconButton
                    aria-label="Remove stage"
                    icon={<TrashIcon size="1rem" />}
                    disabled={stages.length < 2}
                    onClick={() => onRemove(index)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {arcs.length > 0 && (
        <svg
          className="wf-arcs"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
        >
          {arcs.map((arc) => {
            const span = Math.abs(arc.to - arc.from);
            const dip = 12 + span * ARC_STEP;
            const x1 = centre(arc.from);
            const x2 = centre(arc.to);
            return (
              <path
                key={`${arc.from}:${arc.result}`}
                className="wf-arc"
                data-result={arc.result}
                d={`M ${x1} 0 C ${x1} ${dip}, ${x2} ${dip}, ${x2} 0`}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** What the arc colors mean. */
export function CanvasLegend() {
  return (
    <ul className="wf-legend text-body-sm" aria-label="What the arcs mean">
      {RESULTS.map(({ result, label }) => (
        <li key={result}>
          <span className="wf-swatch" data-result={result} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}
