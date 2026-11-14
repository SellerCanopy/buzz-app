import { useEffect, useState, type ReactNode } from "react";
import { HexagonIcon, PlusIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import type { EmbeddedThreadProps } from "../conversation/EmbeddedThread";
import type { Navigation } from "../navigation/controller";
import type { PageProps } from "../pages/service";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import { BoardPage } from "./BoardPage";
import { CardPage } from "./CardPage";
import { NewCardDialog } from "./NewCardDialog";
import {
  boardTarget,
  cardTarget,
  isBeehivePage,
  visitedCard,
  visitedTab,
  type CardTab,
} from "./routes";
import "./beehive.css";

/** What the signed-in person may do. Unknown counts as nothing. */
function useAccess(client: Client) {
  const [access, setAccess] = useState({ canRun: false, isAdmin: false });
  useEffect(() => {
    const abort = new AbortController();
    client
      .whoAmI(abort.signal)
      .then((me) =>
        setAccess({
          canRun: me.role === "run" || me.role === "admin",
          isAdmin: me.role === "admin",
        }),
      )
      .catch(() => setAccess({ canRun: false, isAdmin: false }));
    return () => abort.abort();
  }, [client]);
  return access;
}

/**
 * The Beehive destination: a workspace pane whose header stays mounted in every
 * state. A card is its own visit of this page, so Back returns to the board.
 */
export function BeehivePage({
  client,
  relay,
  navigation,
  navigator,
  Thread,
}: {
  client: Client;
  relay: RelayData;
  /** The host's embedded thread, as Channels shows it. */
  Thread: (props: EmbeddedThreadProps) => ReactNode;
} & Pick<PageProps, "navigation"> & { navigator?: Navigation | undefined }) {
  const { canRun, isAdmin } = useAccess(client);
  const [adding, setAdding] = useState(false);
  const target = navigation?.target;
  const open = target ? visitedCard(target) : undefined;
  const live = !!navigator && !!navigation && !navigation.signal.aborted;

  const openCard = (card: string) => {
    if (!live || !target || !isBeehivePage(target)) return;
    void navigator.open(cardTarget(target, card));
  };
  // A tab is its own visit, so Back returns to the tab a person left.
  const openTab = (tab: CardTab) => {
    if (!live || !target || !isBeehivePage(target) || !open) return;
    void navigator.open(cardTarget(target, open, tab));
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
              relay={relay}
              canRun={canRun}
              isAdmin={isAdmin}
              onOpen={openCard}
              onNew={() => setAdding(true)}
            />
          </div>
          {open !== undefined && (
            <CardPage
              key={open}
              client={client}
              relay={relay}
              navigator={navigator}
              Thread={Thread}
              id={open}
              tab={target ? visitedTab(target) : undefined}
              canRun={canRun}
              onTab={openTab}
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
