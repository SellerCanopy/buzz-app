import { useState } from "react";
import { WarningCircleIcon } from "../../shared/design-system/icons";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import { useInbox } from "./engine/useInbox";
import { CardList } from "./CardList";
import { IntakePage } from "./IntakePage";
import { NeedsYouPage } from "./NeedsYouPage";
import { SettingsPage } from "./SettingsPage";
import { UsagePage } from "./UsagePage";
import { WorkflowsPage } from "./WorkflowsPage";

type View =
  | "board"
  | "needs-you"
  | "archive"
  | "intake"
  | "workflows"
  | "usage"
  | "settings";

/**
 * The views of the Beehive page and the switch between them. Each view reads what it shows
 * and nothing else runs, so Workflows, Usage and Settings keep no poll open. The one
 * exception is Needs you: its list stays current while another view shows, because the count
 * on its tab tells a person something waits. A card opens on its own page.
 */
export function BeehiveViews({
  client,
  relay,
  canRun,
  isAdmin,
  me,
  onOpen,
  onNew,
}: {
  client: Client;
  relay: RelayData;
  canRun: boolean;
  isAdmin: boolean;
  /** The signed-in person's pubkey. */
  me: string;
  onOpen(card: string): void;
  onNew(): void;
}) {
  const [view, setView] = useState<View>("board");
  const { inbox, retry, refresh } = useInbox(client);
  const waiting =
    inbox.status === "ready"
      ? inbox.items.filter((item) => !item.resolvedAt).length
      : 0;
  // A count of zero must mean nothing waits, never that the list could not be read.
  const unsure =
    inbox.status === "error" ||
    (inbox.status === "ready" && !!(inbox.paused ?? inbox.stale));
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
            {
              value: "needs-you",
              label: "Needs you",
              trailing: (
                <>
                  <CountBadge
                    count={waiting}
                    label={`${waiting} ${waiting === 1 ? "item needs" : "items need"} you`}
                  />
                  {unsure && (
                    <span
                      role="img"
                      aria-label="What needs you could not be checked"
                    >
                      <WarningCircleIcon size="0.875rem" />
                    </span>
                  )}
                </>
              ),
            },
            { value: "archive", label: "Archive" },
            { value: "intake", label: "Intake" },
            { value: "workflows", label: "Workflows" },
            { value: "usage", label: "Usage" },
            { value: "settings", label: "Settings" },
          ]}
        />
      </div>
      {view === "needs-you" && (
        <NeedsYouPage
          client={client}
          inbox={inbox}
          canRun={canRun}
          onOpen={onOpen}
          onAnswered={refresh}
          onRetry={retry}
        />
      )}
      {view === "intake" && <IntakePage client={client} canRun={canRun} />}
      {view === "workflows" && <WorkflowsPage client={client} />}
      {view === "usage" && <UsagePage client={client} />}
      {view === "settings" && (
        <SettingsPage client={client} relay={relay} isAdmin={isAdmin} me={me} />
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
