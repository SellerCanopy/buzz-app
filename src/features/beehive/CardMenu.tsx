import { DotsThreeIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import type { Confirm } from "./CardConfirm";

/**
 * The More actions menu of a card page: where the card's issue and pull request open, and, for a
 * person who can run, resetting and removing the card. Both of those ask first, through
 * `onConfirm`. An empty link is left out.
 */
export function CardMenu({
  issueLink,
  pullLink,
  canReset,
  canRun,
  onConfirm,
}: {
  issueLink: string;
  pullLink: string;
  canReset: boolean;
  canRun: boolean;
  onConfirm(kind: Confirm): void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <IconButton
            aria-label="More actions"
            icon={<DotsThreeIcon size="1rem" />}
          />
        }
      />
      <MenuPopup>
        {(issueLink || pullLink) && (
          <MenuGroup>
            <MenuGroupLabel>Open from this card</MenuGroupLabel>
            {issueLink && (
              <MenuLinkItem href={issueLink} target="_blank" rel="noreferrer">
                Open issue
              </MenuLinkItem>
            )}
            {pullLink && (
              <MenuLinkItem href={pullLink} target="_blank" rel="noreferrer">
                Open pull request
              </MenuLinkItem>
            )}
          </MenuGroup>
        )}
        {(issueLink || pullLink) && canRun && <MenuSeparator />}
        {canReset && (
          <MenuItem onClick={() => onConfirm("reset")}>
            Reset this card
          </MenuItem>
        )}
        {canRun && (
          <MenuItem tone="danger" onClick={() => onConfirm("remove")}>
            Remove this card
          </MenuItem>
        )}
      </MenuPopup>
    </MenuRoot>
  );
}
