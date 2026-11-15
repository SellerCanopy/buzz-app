import { useState } from "react";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import { CardList } from "./CardList";
import { SettingsPage } from "./SettingsPage";
import { WorkflowsPage } from "./WorkflowsPage";

type View = "board" | "archive" | "workflows" | "settings";

/**
 * The four views of the Beehive page and the switch between them. Each view reads
 * what it shows and nothing else runs, so Workflows and Settings keep no poll open.
 * A card opens on its own page.
 */
export function BeehiveViews({
  client,
  relay,
  canRun,
  isAdmin,
  onOpen,
  onNew,
}: {
  client: Client;
  relay: RelayData;
  canRun: boolean;
  isAdmin: boolean;
  onOpen(card: string): void;
  onNew(): void;
}) {
  const [view, setView] = useState<View>("board");
  return (
    <>
      <div className="beehive-toolbar">
        <Tabs
          variant="segmented"
          size="sm"
          label="View"
          value={view}
          onValueChange={setView}
          items={[
            { value: "board", label: "Board" },
            { value: "archive", label: "Archive" },
            { value: "workflows", label: "Workflows" },
            { value: "settings", label: "Settings" },
          ]}
        />
      </div>
      {view === "workflows" && <WorkflowsPage client={client} />}
      {view === "settings" && (
        <SettingsPage client={client} relay={relay} isAdmin={isAdmin} />
      )}
      {(view === "board" || view === "archive") && (
        <CardList
          client={client}
          archived={view === "archive"}
          canRun={canRun}
          onOpen={onOpen}
          onNew={onNew}
        />
      )}
    </>
  );
}
