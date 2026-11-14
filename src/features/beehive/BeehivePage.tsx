import { useEffect, useState } from "react";
import { HexagonIcon, PlusIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import type { Navigation } from "../navigation/controller";
import type { PageProps } from "../pages/service";
import type { Client } from "./engine/client";
import { BoardPage } from "./BoardPage";
import { CardPage } from "./CardPage";
import { NewCardDialog } from "./NewCardDialog";
import { boardTarget, cardTarget, isBeehivePage, visitedCard } from "./routes";
import "./beehive.css";

/** Whether the signed-in person may add and archive cards. Unknown counts as no. */
function useCanRun(client: Client) {
  const [canRun, setCanRun] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    client
      .whoAmI(abort.signal)
      .then((me) => setCanRun(me.role === "run" || me.role === "admin"))
      .catch(() => setCanRun(false));
    return () => abort.abort();
  }, [client]);
  return canRun;
}

/**
 * The Beehive destination: a workspace pane whose header stays mounted in every
 * state. A card is its own visit of this page, so Back returns to the board.
 */
export function BeehivePage({
  client,
  navigation,
  navigator,
}: {
  client: Client;
} & Pick<PageProps, "navigation"> & { navigator?: Navigation | undefined }) {
  const canRun = useCanRun(client);
  const [adding, setAdding] = useState(false);
  const target = navigation?.target;
  const open = target ? visitedCard(target) : undefined;
  const live = !!navigator && !!navigation && !navigation.signal.aborted;

  const openCard = (card: string) => {
    if (!live || !target || !isBeehivePage(target)) return;
    void navigator.open(cardTarget(target, card));
  };
  const closeCard = () => {
    if (!live || !target || !isBeehivePage(target)) return;
    // Close ends this card's visits, so Back does not stop on it again.
    navigator.dismiss(
      (visit) => visitedCard(visit) === open,
      boardTarget(target),
    );
  };

  return (
    <Panel aria-label="Beehive">
      <div className="beehive-page text-body">
        <PanelHeader
          title={
            <PanelHeaderLabel
              title="Beehive"
              icon={<HexagonIcon size="1rem" />}
            />
          }
          actions={
            canRun ? (
              <IconButton
                aria-label="New card"
                icon={<PlusIcon size="1rem" />}
                onClick={() => setAdding(true)}
              />
            ) : undefined
          }
        />
        <div className="beehive-body">
          <div hidden={open !== undefined}>
            <BoardPage
              client={client}
              canRun={canRun}
              onOpen={openCard}
              onNew={() => setAdding(true)}
            />
          </div>
          {open !== undefined && (
            <CardPage
              key={open}
              client={client}
              id={open}
              canRun={canRun}
              onClose={closeCard}
            />
          )}
        </div>
        {adding && (
          <NewCardDialog client={client} onClose={() => setAdding(false)} />
        )}
      </div>
    </Panel>
  );
}
