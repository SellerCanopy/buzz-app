import { HexagonIcon } from "../../shared/design-system/icons";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import type { Client } from "./engine/client";
import { BoardPage } from "./BoardPage";
import "./beehive.css";

/** The Beehive destination: a workspace pane whose header stays mounted in every state. */
export function BeehivePage({ client }: { client: Client }) {
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
        />
        <div className="beehive-body">
          <BoardPage client={client} />
        </div>
      </div>
    </Panel>
  );
}
