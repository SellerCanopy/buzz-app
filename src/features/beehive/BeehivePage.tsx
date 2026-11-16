import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Panel } from "../../shared/design-system/ui/Panel";
import type { EmbeddedThreadProps } from "../conversation/EmbeddedThread";
import type { Navigation } from "../navigation/controller";
import type { PageProps } from "../pages/service";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import { BeehiveViews } from "./BeehiveViews";
import { atLeast, createLevelStore, type LevelStore } from "./level";
import { CardPage } from "./CardPage";
import { NewCardDialog } from "./NewCardDialog";
import { NewWorkflowPage } from "./NewWorkflowPage";
import {
  boardTarget,
  cardTarget,
  isBeehivePage,
  newWorkflowTarget,
  visitedCard,
  visitedNewWorkflow,
  visitedTab,
  visitedWorkflow,
  workflowTarget,
  type CardTab,
} from "./routes";
import { WorkflowEditor, type EditorDraft } from "./WorkflowEditor";
import "./beehive.css";

/**
 * What the signed-in person may do. Only the engine's own answer grants or
 * withholds a control: until it arrives, and when it cannot be read, the person
 * gets nothing, and a failure says so with a way to ask again. The host's own
 * store follows the level while no page is open; a page rendered without one
 * keeps a store for as long as it is mounted.
 */
function useAccess(client: Client, shared: LevelStore | undefined) {
  const own = useMemo(
    () => shared ?? createLevelStore(client),
    [shared, client],
  );
  useEffect(() => (shared ? undefined : own.start()), [shared, own]);
  const state = useSyncExternalStore(own.subscribe, own.get);
  const ready = state.status === "ready" ? state : undefined;
  return {
    canRun: !!ready && atLeast(ready.level, "run"),
    isAdmin: ready?.level === "admin",
    me: ready?.pubkey ?? "",
    problem: state.status === "error" ? state.message : undefined,
    retry: own.refresh,
  };
}

/**
 * The Beehive destination: a workspace pane whose sidebar stays mounted in every
 * state. A card is its own visit of this page, so Back returns to the board.
 */
export function BeehivePage({
  client,
  relay,
  navigation,
  navigator,
  Thread,
  level,
}: {
  client: Client;
  relay: RelayData;
  /** The host's store of the person's level, when it keeps one. */
  level?: LevelStore | undefined;
  /** The host's embedded thread, as Channels shows it. */
  Thread: (props: EmbeddedThreadProps) => ReactNode;
} & Pick<PageProps, "navigation"> & { navigator?: Navigation | undefined }) {
  const { canRun, isAdmin, me, problem, retry } = useAccess(client, level);
  const [adding, setAdding] = useState<"blank" | "issue">();
  const target = navigation?.target;
  const open = target ? visitedCard(target) : undefined;
  const editing = target ? visitedWorkflow(target) : undefined;
  const addingWorkflow = target ? visitedNewWorkflow(target) : false;
  // What a person typed in an editor stays while they go Back and Forward, by workflow.
  const drafts = useRef(new Map<string, EditorDraft>());
  const [workflowsRevision, setWorkflowsRevision] = useState(0);
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
  const openWorkflow = (name: string) => {
    if (!live || !target || !isBeehivePage(target)) return;
    void navigator.open(workflowTarget(target, name));
  };
  const openNewWorkflow = () => {
    if (!live || !target || !isBeehivePage(target)) return;
    void navigator.open(newWorkflowTarget(target));
  };
  // Close ends the editor's visits, so Back does not stop on it again.
  const closeWorkflow = () => {
    if (!live || !target || !isBeehivePage(target)) return;
    navigator.dismiss(
      (visit) => visitedWorkflow(visit) === editing,
      boardTarget(target),
    );
  };
  const closeNewWorkflow = () => {
    if (!live || !target || !isBeehivePage(target)) return;
    navigator.dismiss(visitedNewWorkflow, boardTarget(target));
  };
  // A workflow that was just added or copied opens in the editor in the place of the page
  // that made it.
  const openCreated = (name: string) => {
    setWorkflowsRevision((n) => n + 1);
    if (!live || !target || !isBeehivePage(target)) return;
    navigator.dismiss(
      (visit) =>
        visitedNewWorkflow(visit) || visitedWorkflow(visit) === editing,
      workflowTarget(target, name),
    );
  };
  // Choosing a view in the sidebar leaves whichever page is open. An editor's unsaved text
  // stays in `drafts`, so opening the workflow again returns to it.
  const leavePage = () => {
    if (open !== undefined) closeCard();
    else if (editing !== undefined) closeWorkflow();
    else if (addingWorkflow) closeNewWorkflow();
  };

  return (
    <Panel aria-label="Beehive">
      <div className="beehive-page text-body">
        <div className="beehive-layout">
          <BeehiveViews
            client={client}
            relay={relay}
            canRun={canRun}
            isAdmin={isAdmin}
            me={me}
            notice={
              problem ? (
                <div className="beehive-error">
                  <p role="alert" className="text-danger">
                    {`Could not check what you can do. ${problem}`}
                  </p>
                  <Button onClick={retry}>Retry</Button>
                </div>
              ) : undefined
            }
            card={
              open !== undefined
                ? ({ waiting, refresh }) => (
                    <CardPage
                      key={open}
                      client={client}
                      relay={relay}
                      navigator={navigator}
                      Thread={Thread}
                      id={open}
                      tab={target ? visitedTab(target) : undefined}
                      canRun={canRun}
                      waiting={waiting}
                      onAnswered={refresh}
                      onTab={openTab}
                      onClose={closeCard}
                    />
                  )
                : undefined
            }
            workflowsRevision={workflowsRevision}
            workflowPage={
              editing !== undefined ? (
                <WorkflowEditor
                  key={editing}
                  client={client}
                  name={editing}
                  canRun={canRun}
                  isAdmin={isAdmin}
                  me={me}
                  restored={drafts.current.get(editing)}
                  onDraft={(draft) =>
                    draft
                      ? drafts.current.set(editing, draft)
                      : drafts.current.delete(editing)
                  }
                  onChanged={() => setWorkflowsRevision((n) => n + 1)}
                  onCopied={openCreated}
                  onClose={closeWorkflow}
                />
              ) : addingWorkflow ? (
                <NewWorkflowPage
                  client={client}
                  isAdmin={isAdmin}
                  me={me}
                  onCreated={openCreated}
                  onClose={closeNewWorkflow}
                />
              ) : undefined
            }
            onLeaveCard={leavePage}
            onEditWorkflow={openWorkflow}
            onNewWorkflow={openNewWorkflow}
            onWorkflowsChanged={() => setWorkflowsRevision((n) => n + 1)}
            onOpen={openCard}
            onNew={() => setAdding("blank")}
            onNewFromIssue={() => setAdding("issue")}
          />
        </div>
        {adding && (
          <NewCardDialog
            client={client}
            initial={adding}
            onClose={() => setAdding(undefined)}
          />
        )}
      </div>
    </Panel>
  );
}
