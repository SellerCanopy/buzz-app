import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Button } from "../../shared/design-system/ui/Button";
import type { Workflow } from "./gen/kiln/engine/v1/engine_pb";

/**
 * Where a card can be sorted: Backlog, or a workflow, which puts it in To do. The In progress
 * and Done lanes follow a card's run, so a person cannot move a card into them. `onArchive`
 * adds an Archive item for a menu that acts on a selection.
 */
export function MoveMenu({
  label,
  cardLabel,
  workflows,
  current,
  disabled,
  onMove,
  onArchive,
}: {
  label: string;
  /** The accessible name when the visible label alone would be ambiguous. */
  cardLabel?: string;
  workflows: Workflow[];
  /** The workflow a single card is in, which is left out of the menu. */
  current?: string;
  disabled: boolean;
  /** An empty workflow is Backlog. */
  onMove(workflow: string): void;
  onArchive?(): void;
}) {
  const choices = workflows.filter(
    (workflow) => workflow.ok && workflow.name !== current,
  );
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <Button size="sm" disabled={disabled} aria-label={cardLabel}>
            {label}
          </Button>
        }
      />
      <MenuPopup>
        {current !== "" && (
          <MenuItem onClick={() => onMove("")}>Backlog</MenuItem>
        )}
        {choices.length > 0 && (
          <MenuGroup>
            <MenuGroupLabel>To do, with workflow</MenuGroupLabel>
            {choices.map((workflow) => (
              <MenuItem
                key={workflow.name}
                onClick={() => onMove(workflow.name)}
              >
                {workflow.name}
              </MenuItem>
            ))}
          </MenuGroup>
        )}
        {onArchive && (
          <>
            <MenuSeparator />
            <MenuItem onClick={onArchive}>Archive</MenuItem>
          </>
        )}
      </MenuPopup>
    </MenuRoot>
  );
}
