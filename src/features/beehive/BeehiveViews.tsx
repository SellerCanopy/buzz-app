import { useState, type ReactNode } from "react";
import {
  HexagonIcon,
  PlusIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { SidebarNavigation } from "../../shared/design-system/ui/SidebarNavigation";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import type { InboxItem } from "./gen/kiln/engine/v1/engine_pb";
import { useInbox } from "./engine/useInbox";
import { Board } from "./Board";
import { ImportWorkflowDialog } from "./ImportWorkflowDialog";
import { IntakePage } from "./IntakePage";
import { NeedsYouPage } from "./NeedsYouPage";
import { SettingsPage } from "./SettingsPage";
import { UsagePage } from "./UsagePage";
import { WorkflowsPage } from "./WorkflowsPage";

type View =
  | "board"
  | "needs-you"
  | "intake"
  | "workflows"
  | "usage"
  | "settings";

/** The sidebar's two sections, in the order and with the names the design gives them. */
const SECTIONS: { label: string; views: { view: View; label: string }[] }[] = [
  {
    label: "Work",
    views: [
      { view: "board", label: "Board" },
      { view: "needs-you", label: "Needs you" },
      { view: "intake", label: "Intake" },
    ],
  },
  {
    label: "Manage",
    views: [
      { view: "workflows", label: "Workflows" },
      { view: "usage", label: "Usage" },
      { view: "settings", label: "Settings" },
    ],
  },
];

/**
 * The shell of the Beehive page: a sidebar to choose a view, and the view beside it. Each view
 * reads what it shows and nothing else runs, so Workflows, Usage and Settings keep no poll
 * open. The one exception is Needs you: its list stays current while another view shows,
 * because the count on its sidebar row tells a person something waits. A card opens on its own
 * page in the same place, and choosing a view in the sidebar closes it.
 */
export function BeehiveViews({
  client,
  relay,
  canRun,
  isAdmin,
  me,
  notice,
  card,
  workflowPage,
  workflowsRevision,
  onLeaveCard,
  onOpen,
  onNew,
  onNewFromIssue,
  onAskAssistant,
  onEditWorkflow,
  onNewWorkflow,
  onWorkflowsChanged,
}: {
  client: Client;
  /** Settings reads the relay's channels, so a page without a relay has no Settings. */
  relay: RelayData | undefined;
  canRun: boolean;
  isAdmin: boolean;
  /** The signed-in person's pubkey. */
  me: string;
  /** What to say above the view, such as that the person's level could not be read. */
  notice?: ReactNode;
  /**
   * The open card's page, which takes the view's place while it is open. It is given the open
   * items of the inbox and a way to read the inbox again, which the shell keeps current.
   */
  card?:
    | ((inbox: { waiting: InboxItem[]; refresh(): void }) => ReactNode)
    | undefined;
  /** The workflow editor or the new workflow page, which also takes the view's place. */
  workflowPage?: ReactNode;
  /** Changes when a workflow was saved, deleted or imported, so the list reads again. */
  workflowsRevision: number;
  /** Closes the open card or workflow page, as when another view is chosen. */
  onLeaveCard(): void;
  onOpen(card: string): void;
  onNew(): void;
  /** Opens the new card form on its From an issue tab. */
  onNewFromIssue(): void;
  /** Opens the assistant over the view. Absent when there is no assistant. */
  onAskAssistant?: (() => void) | undefined;
  onEditWorkflow(name: string): void;
  onNewWorkflow(): void;
  onWorkflowsChanged(): void;
}) {
  const [chosen, setView] = useState<View>("board");
  const [importing, setImporting] = useState(false);
  const [archived, setArchived] = useState(false);
  const { inbox, retry, refresh } = useInbox(client);
  const open = card !== undefined || workflowPage !== undefined;
  // A workflow page opened from a link or by Back has no view chosen, and belongs to Workflows.
  const view = workflowPage !== undefined ? "workflows" : chosen;
  const openItems =
    inbox.status === "ready"
      ? inbox.items.filter((item) => !item.resolvedAt)
      : [];
  const waiting = openItems.length;
  // A count of zero must mean nothing waits, never that the list could not be read.
  const unsure =
    inbox.status === "error" ||
    (inbox.status === "ready" && !!(inbox.paused ?? inbox.stale));

  const choose = (next: View) => {
    setView(next);
    // Choosing the board always lands on the live cards.
    if (next === "board") setArchived(false);
    if (open) onLeaveCard();
  };
  const trailing = (next: View) =>
    next === "needs-you" ? (
      <>
        <CountBadge
          count={waiting}
          label={`${waiting} ${waiting === 1 ? "item needs" : "items need"} you`}
        />
        {unsure && (
          <span role="img" aria-label="What needs you could not be checked">
            <WarningCircleIcon size="0.875rem" />
          </span>
        )}
      </>
    ) : undefined;

  return (
    <>
      <div className="beehive-sidebar">
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
                onClick={onNew}
              />
            ) : undefined
          }
        />
        <nav className="beehive-nav" aria-label="Beehive views">
          <SidebarNavigation>
            {SECTIONS.map((section) => (
              <NavigationSection key={section.label} label={section.label}>
                {section.views
                  .filter((item) => relay || item.view !== "settings")
                  .map((item) => (
                    <NavigationItem
                      key={item.view}
                      label={item.label}
                      selected={view === item.view}
                      trailing={trailing(item.view)}
                      onClick={() => choose(item.view)}
                    />
                  ))}
              </NavigationSection>
            ))}
          </SidebarNavigation>
        </nav>
      </div>
      <div className="beehive-body">
        {notice}
        <div className="beehive-view" hidden={open}>
          {view === "board" && (
            <Board
              client={client}
              canRun={canRun}
              archived={archived}
              onArchived={setArchived}
              waiting={openItems}
              onOpen={onOpen}
              onNew={onNew}
              onNewFromIssue={onNewFromIssue}
              onAskAssistant={onAskAssistant}
              onOpenNeedsYou={() => choose("needs-you")}
            />
          )}
          {view === "needs-you" && (
            <>
              <Header
                title="Needs you"
                subtitle={
                  inbox.status === "ready"
                    ? `${waiting} waiting. Oldest first.`
                    : undefined
                }
              />
              <NeedsYouPage
                client={client}
                inbox={inbox}
                canRun={canRun}
                onOpen={onOpen}
                onAnswered={refresh}
                onRetry={retry}
              />
            </>
          )}
          {/* Intake's own header carries its buttons, so it is not drawn here. */}
          {view === "intake" && <IntakePage client={client} canRun={canRun} />}
          {view === "workflows" && (
            <>
              <Header
                title="Workflows"
                subtitle="The stages a card runs through."
                actions={
                  <>
                    {canRun && (
                      <Button onClick={() => setImporting(true)}>Import</Button>
                    )}
                    {onAskAssistant && (
                      <Button onClick={onAskAssistant}>
                        With the assistant
                      </Button>
                    )}
                    {canRun && (
                      <Button variant="prominent" onClick={onNewWorkflow}>
                        New workflow
                      </Button>
                    )}
                  </>
                }
              />
              <WorkflowsPage
                client={client}
                canRun={canRun}
                revision={workflowsRevision}
                onEdit={onEditWorkflow}
              />
            </>
          )}
          {view === "usage" && (
            <>
              <Header
                title="Usage"
                subtitle="Runs and cards for the last four weeks. Beehive does not track tokens or cost."
              />
              <UsagePage client={client} />
            </>
          )}
          {view === "settings" && relay && (
            <>
              <Header title="Settings" />
              <SettingsPage
                client={client}
                relay={relay}
                isAdmin={isAdmin}
                me={me}
              />
            </>
          )}
        </div>
        {card?.({ waiting: openItems, refresh })}
        {workflowPage}
        {importing && (
          <ImportWorkflowDialog
            client={client}
            onImported={() => {
              setImporting(false);
              onWorkflowsChanged();
            }}
            onClose={() => setImporting(false)}
          />
        )}
      </div>
    </>
  );
}
