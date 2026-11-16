import {
  create,
  fromJson,
  toJson,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  AcceptTicketProposalRequestSchema,
  AcceptTicketProposalResponseSchema,
  AccessEntrySchema,
  AgentToolsChangeSchema,
  AddIssueRepoRequestSchema,
  AddNoteRequestSchema,
  AddNoteResponseSchema,
  ArtifactVersionSchema,
  ArchiveCardsRequestSchema,
  ArchiveCardsResponseSchema,
  AnswerInboxRequestSchema,
  CancelJobRequestSchema,
  CancelJobResponseSchema,
  CardSchema,
  InboxItemSchema,
  CheckWorkflowRequestSchema,
  CheckWorkflowResponseSchema,
  CreateCardRequestSchema,
  DeleteIntakeRuleRequestSchema,
  DeleteIntakeRuleResponseSchema,
  CreateTaskRequestSchema,
  GetCardRequestSchema,
  GetHiveHealthRequestSchema,
  GetHiveHealthResponseSchema,
  GetSettingsRequestSchema,
  GetSettingsResponseSchema,
  GetStatusRequestSchema,
  GetStatusResponseSchema,
  GetUsageRequestSchema,
  GetUsageResponseSchema,
  ListAccessRequestSchema,
  ListAccessResponseSchema,
  ListActivityRequestSchema,
  ListActivityResponseSchema,
  ListArtifactsRequestSchema,
  ListArtifactsResponseSchema,
  ListArtifactVersionsRequestSchema,
  ListArtifactVersionsResponseSchema,
  ListCardsRequestSchema,
  ListCardsResponseSchema,
  IntakeRuleSchema,
  type IntakeSchema,
  ListInboxRequestSchema,
  ListInboxResponseSchema,
  ListIntakeRulesRequestSchema,
  ListIntakeRulesResponseSchema,
  ListIssueCommentsRequestSchema,
  ListIssueCommentsResponseSchema,
  ListReposRequestSchema,
  ListReposResponseSchema,
  ListRunsRequestSchema,
  ListRunsResponseSchema,
  ListProposalsRequestSchema,
  ListProposalsResponseSchema,
  ListWorkflowsRequestSchema,
  ListWorkflowsResponseSchema,
  MergeCardRequestSchema,
  PauseCardRequestSchema,
  PollEventsRequestSchema,
  PreviewIntakeRequestSchema,
  PreviewIntakeResponseSchema,
  PollEventsResponseSchema,
  ReadArtifactRequestSchema,
  RemoveCardRequestSchema,
  RemoveIssueRepoRequestSchema,
  RemoveCardResponseSchema,
  RefreshIntakeRequestSchema,
  RefreshIntakeResponseSchema,
  ResetCardRequestSchema,
  ResolveProposalRequestSchema,
  ResolveProposalResponseSchema,
  ResumeCardRequestSchema,
  RestoreCardRequestSchema,
  RetryRunRequestSchema,
  RunSchema,
  SaveIntakeRuleRequestSchema,
  SearchIssuesRequestSchema,
  SearchIssuesResponseSchema,
  SetAccessLevelRequestSchema,
  SetAutoModeRequestSchema,
  SetCardWorkflowRequestSchema,
  SetCardWorkflowResponseSchema,
  SetSettingRequestSchema,
  SettingSchema,
  StartChatRequestSchema,
  StartJobResponseSchema,
  StartStageRequestSchema,
  StopRunRequestSchema,
  WhoAmIRequestSchema,
  WhoAmIResponseSchema,
  DeleteWorkflowRequestSchema,
  DeleteWorkflowResponseSchema,
  DuplicateWorkflowRequestSchema,
  ExportWorkflowRequestSchema,
  ExportWorkflowResponseSchema,
  GetWorkflowDraftRequestSchema,
  GetWorkflowDraftResponseSchema,
  ImportWorkflowRequestSchema,
  ListAgentsRequestSchema,
  ListAgentsResponseSchema,
  ListAgentToolServersRequestSchema,
  ListAgentToolServersResponseSchema,
  RemoveAgentToolServerRequestSchema,
  SetAgentToolServerRequestSchema,
  ListStageTemplatesRequestSchema,
  ListStageTemplatesResponseSchema,
  SaveWorkflowRequestSchema,
  SaveWorkflowResponseSchema,
  WorkflowSchema,
} from "../gen/kiln/engine/v1/engine_pb";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { Session } from "./session";

const SERVICE = "/kiln.engine.v1.EngineService/";

/** A package's files by path, as text. */
export type WorkflowFiles = { name: string; files: Record<string, string> };

const encoder = new TextEncoder();

function toDraft(draft: WorkflowFiles) {
  return {
    name: draft.name,
    files: Object.fromEntries(
      Object.entries(draft.files).map(([path, text]) => [
        path,
        encoder.encode(text),
      ]),
    ),
  };
}

/** The Beehive methods the app calls. Each phase adds the methods it needs. */
export function createClient(session: Session) {
  async function unary<I extends DescMessage, O extends DescMessage>(
    method: string,
    input: I,
    output: O,
    request: MessageShape<I>,
    signal?: AbortSignal,
  ): Promise<MessageShape<O>> {
    const reply = await session.call(
      `${SERVICE}${method}`,
      toJson(input, request),
      signal,
    );
    // An older app can meet a newer engine: ignore fields it does not know.
    return fromJson(output, reply as never, { ignoreUnknownFields: true });
  }
  return {
    listCards: (archived = false, signal?: AbortSignal) =>
      unary(
        "ListCards",
        ListCardsRequestSchema,
        ListCardsResponseSchema,
        create(ListCardsRequestSchema, { archived }),
        signal,
      ),
    getCard: (cardId: string, signal?: AbortSignal) =>
      unary(
        "GetCard",
        GetCardRequestSchema,
        CardSchema,
        create(GetCardRequestSchema, { cardId }),
        signal,
      ),
    createCard: (
      input: {
        title?: string;
        description?: string;
        workflow?: string;
        /** An issue on github.com: the card takes its title and body from it. */
        issue?: { owner: string; repo: string; number: number };
      },
      signal?: AbortSignal,
    ) =>
      unary(
        "CreateCard",
        CreateCardRequestSchema,
        CardSchema,
        create(CreateCardRequestSchema, {
          ...input,
          issue: input.issue && { host: "github.com", ...input.issue },
        }),
        signal,
      ),
    createTask: (
      input: { sentence: string; description?: string; workflow?: string },
      signal?: AbortSignal,
    ) =>
      unary(
        "CreateTask",
        CreateTaskRequestSchema,
        CardSchema,
        create(CreateTaskRequestSchema, input),
        signal,
      ),
    /**
     * Sort idle cards that have never run into a workflow, or into Backlog with an empty one.
     * All or nothing: the engine refuses the whole batch when one card cannot move.
     */
    setCardWorkflow: (
      moves: { cardId: string; workflow: string }[],
      signal?: AbortSignal,
    ) =>
      unary(
        "SetCardWorkflow",
        SetCardWorkflowRequestSchema,
        SetCardWorkflowResponseSchema,
        create(SetCardWorkflowRequestSchema, { moves }),
        signal,
      ),
    archiveCards: (cardIds: string[], signal?: AbortSignal) =>
      unary(
        "ArchiveCards",
        ArchiveCardsRequestSchema,
        ArchiveCardsResponseSchema,
        create(ArchiveCardsRequestSchema, { cardIds }),
        signal,
      ),
    restoreCard: (cardId: string, signal?: AbortSignal) =>
      unary(
        "RestoreCard",
        RestoreCardRequestSchema,
        CardSchema,
        create(RestoreCardRequestSchema, { cardId }),
        signal,
      ),
    /**
     * Merge the card's pull request. Only a person can: the engine refuses an agent, a draft, a
     * pull request with failing or unfinished checks and a card that has a stage working on it.
     * The reply is the card as `getCard` reads it.
     */
    mergeCard: (cardId: string, signal?: AbortSignal) =>
      unary(
        "MergeCard",
        MergeCardRequestSchema,
        CardSchema,
        create(MergeCardRequestSchema, { cardId }),
        signal,
      ),
    /** Turn auto mode on or off for a card. The reply is the card as `getCard` reads it. */
    setAutoMode: (cardId: string, enabled: boolean, signal?: AbortSignal) =>
      unary(
        "SetAutoMode",
        SetAutoModeRequestSchema,
        CardSchema,
        create(SetAutoModeRequestSchema, { cardId, enabled }),
        signal,
      ),
    addNote: (
      input: { cardId: string; summary: string; detail?: string },
      signal?: AbortSignal,
    ) =>
      unary(
        "AddNote",
        AddNoteRequestSchema,
        AddNoteResponseSchema,
        create(AddNoteRequestSchema, input),
        signal,
      ),
    /** One long poll: returns at once with events after `afterSeq`, or empty after `waitSeconds`. */
    pollEvents: (afterSeq: bigint, waitSeconds: number, signal?: AbortSignal) =>
      unary(
        "PollEvents",
        PollEventsRequestSchema,
        PollEventsResponseSchema,
        create(PollEventsRequestSchema, { afterSeq, waitSeconds }),
        signal,
      ),
    /** Start a run on a card at its workflow's first stage. */
    startRun: (cardId: string, signal?: AbortSignal) =>
      unary(
        "StartStage",
        StartStageRequestSchema,
        RunSchema,
        create(StartStageRequestSchema, { cardId }),
        signal,
      ),
    /** End a run that has not ended: the card moves to Stopped. */
    stopRun: (runId: string, signal?: AbortSignal) =>
      unary(
        "StopRun",
        StopRunRequestSchema,
        RunSchema,
        create(StopRunRequestSchema, { runId }),
        signal,
      ),
    /** Start a new run from the stage a failed or stopped run reached, with the same settings. */
    retryRun: (runId: string, signal?: AbortSignal) =>
      unary(
        "RetryRun",
        RetryRunRequestSchema,
        RunSchema,
        create(RetryRunRequestSchema, { runId }),
        signal,
      ),
    /** A card's runs, newest first. An empty `cardId` reads the runs of every card. */
    listRuns: (cardId = "", signal?: AbortSignal) =>
      unary(
        "ListRuns",
        ListRunsRequestSchema,
        ListRunsResponseSchema,
        create(ListRunsRequestSchema, { cardId }),
        signal,
      ),
    /** Hold a running card: its run stops where it is until `resumeCard`. */
    pauseCard: (cardId: string, signal?: AbortSignal) =>
      unary(
        "PauseCard",
        PauseCardRequestSchema,
        CardSchema,
        create(PauseCardRequestSchema, { cardId }),
        signal,
      ),
    /** Stop a card's run and put the card back to idle. Its artifacts and branch are kept. */
    resetCard: (cardId: string, signal?: AbortSignal) =>
      unary(
        "ResetCard",
        ResetCardRequestSchema,
        CardSchema,
        create(ResetCardRequestSchema, { cardId }),
        signal,
      ),
    /** Take a card off the board for good. The engine refuses a card whose run is working. */
    removeCard: (cardId: string, signal?: AbortSignal) =>
      unary(
        "RemoveCard",
        RemoveCardRequestSchema,
        RemoveCardResponseSchema,
        create(RemoveCardRequestSchema, { cardId }),
        signal,
      ),
    /**
     * Add an `owner/name` repo to the card. The reply is the card with its repos. The engine
     * refuses a repo it cannot read, one the card has, and a card whose run is active.
     */
    addIssueRepo: (cardId: string, repo: string, signal?: AbortSignal) =>
      unary(
        "AddIssueRepo",
        AddIssueRepoRequestSchema,
        CardSchema,
        create(AddIssueRepoRequestSchema, { cardId, repo }),
        signal,
      ),
    /**
     * Take an extra repo off the card. The reply is the card with its repos. The engine refuses
     * the repo the card runs in while others remain, one with an open pull request, and a card
     * whose run is active.
     */
    removeIssueRepo: (cardId: string, repo: string, signal?: AbortSignal) =>
      unary(
        "RemoveIssueRepo",
        RemoveIssueRepoRequestSchema,
        CardSchema,
        create(RemoveIssueRepoRequestSchema, { cardId, repo }),
        signal,
      ),
    /** Let a held card carry on: a stage held before it started posts its task. */
    resumeCard: (cardId: string, signal?: AbortSignal) =>
      unary(
        "ResumeCard",
        ResumeCardRequestSchema,
        RunSchema,
        create(ResumeCardRequestSchema, { cardId }),
        signal,
      ),
    /** The documents and files a card's stages saved, one entry per name. */
    listArtifacts: (cardId: string, signal?: AbortSignal) =>
      unary(
        "ListArtifacts",
        ListArtifactsRequestSchema,
        ListArtifactsResponseSchema,
        create(ListArtifactsRequestSchema, { cardId }),
        signal,
      ),
    /** Every version of one artifact, oldest first, without a document's text. */
    listArtifactVersions: (
      cardId: string,
      name: string,
      signal?: AbortSignal,
    ) =>
      unary(
        "ListArtifactVersions",
        ListArtifactVersionsRequestSchema,
        ListArtifactVersionsResponseSchema,
        create(ListArtifactVersionsRequestSchema, { cardId, name }),
        signal,
      ),
    /** One version of an artifact with its text. Version 0 reads the latest. */
    readArtifact: (
      cardId: string,
      name: string,
      version = 0,
      signal?: AbortSignal,
    ) =>
      unary(
        "ReadArtifact",
        ReadArtifactRequestSchema,
        ArtifactVersionSchema,
        create(ReadArtifactRequestSchema, { cardId, name, version }),
        signal,
      ),
    /** What applies at the community scope: every key, with the layer that set it. */
    getCommunitySettings: (signal?: AbortSignal) =>
      unary(
        "GetSettings",
        GetSettingsRequestSchema,
        GetSettingsResponseSchema,
        create(GetSettingsRequestSchema, { scope: "user" }),
        signal,
      ),
    /** Set one community setting to a JSON value. An empty `valueJson` removes it. */
    setCommunitySetting: (
      key: string,
      valueJson: string,
      signal?: AbortSignal,
    ) =>
      unary(
        "SetSetting",
        SetSettingRequestSchema,
        SettingSchema,
        create(SetSettingRequestSchema, { scope: "user", key, valueJson }),
        signal,
      ),
    whoAmI: (signal?: AbortSignal) =>
      unary(
        "WhoAmI",
        WhoAmIRequestSchema,
        WhoAmIResponseSchema,
        create(WhoAmIRequestSchema),
        signal,
      ),
    listWorkflows: (signal?: AbortSignal) =>
      unary(
        "ListWorkflows",
        ListWorkflowsRequestSchema,
        ListWorkflowsResponseSchema,
        create(ListWorkflowsRequestSchema),
        signal,
      ),
    /** Check one unsaved package as the editor holds it, in place of a loaded one. */
    checkDraft: (draft: WorkflowFiles, signal?: AbortSignal) =>
      unary(
        "CheckWorkflow",
        CheckWorkflowRequestSchema,
        CheckWorkflowResponseSchema,
        create(CheckWorkflowRequestSchema, { draft: toDraft(draft) }),
        signal,
      ),
    /** A package's files as text, with the hash an edit of them is made against. */
    getWorkflowDraft: (name: string, signal?: AbortSignal) =>
      unary(
        "GetWorkflowDraft",
        GetWorkflowDraftRequestSchema,
        GetWorkflowDraftResponseSchema,
        create(GetWorkflowDraftRequestSchema, { name, text: true }),
        signal,
      ),
    /**
     * Save a package. `baseHash` is the hash the files were opened at, and empty for a new
     * name. A save made against an older hash fails with `failed_precondition`, and a draft the
     * checks find errors in fails with `invalid_argument`. Nothing is written in either case.
     */
    saveWorkflow: (
      draft: WorkflowFiles,
      baseHash: string,
      signal?: AbortSignal,
    ) =>
      unary(
        "SaveWorkflow",
        SaveWorkflowRequestSchema,
        SaveWorkflowResponseSchema,
        create(SaveWorkflowRequestSchema, {
          draft: toDraft(draft),
          baseHash,
        }),
        signal,
      ),
    /** Copy a package under a new name. The copy is the person's own. */
    duplicateWorkflow: (name: string, newName: string, signal?: AbortSignal) =>
      unary(
        "DuplicateWorkflow",
        DuplicateWorkflowRequestSchema,
        WorkflowSchema,
        create(DuplicateWorkflowRequestSchema, { name, newName }),
        signal,
      ),
    /** Delete a saved package. A built-in, or one a card still uses, is refused. */
    deleteWorkflow: (name: string, signal?: AbortSignal) =>
      unary(
        "DeleteWorkflow",
        DeleteWorkflowRequestSchema,
        DeleteWorkflowResponseSchema,
        create(DeleteWorkflowRequestSchema, { name }),
        signal,
      ),
    /** A package as a zip of its files. */
    exportWorkflow: (name: string, signal?: AbortSignal) =>
      unary(
        "ExportWorkflow",
        ExportWorkflowRequestSchema,
        ExportWorkflowResponseSchema,
        create(ExportWorkflowRequestSchema, { name }),
        signal,
      ),
    /** Add the package in a zip, under `name` when given. */
    importWorkflow: (zip: Uint8Array, name = "", signal?: AbortSignal) =>
      unary(
        "ImportWorkflow",
        ImportWorkflowRequestSchema,
        WorkflowSchema,
        create(ImportWorkflowRequestSchema, { zip, name }),
        signal,
      ),
    /** The stages a person can add, each as the JSON a workflow's stage holds. */
    listStageTemplates: (signal?: AbortSignal) =>
      unary(
        "ListStageTemplates",
        ListStageTemplatesRequestSchema,
        ListStageTemplatesResponseSchema,
        create(ListStageTemplatesRequestSchema),
        signal,
      ),
    /** The agents in the community by display name, which a workflow stage names. */
    listAgents: (signal?: AbortSignal) =>
      unary(
        "ListAgents",
        ListAgentsRequestSchema,
        ListAgentsResponseSchema,
        create(ListAgentsRequestSchema),
        signal,
      ),
    /** Check every package and folder the engine loaded. */
    checkWorkflow: (signal?: AbortSignal) =>
      unary(
        "CheckWorkflow",
        CheckWorkflowRequestSchema,
        CheckWorkflowResponseSchema,
        create(CheckWorkflowRequestSchema),
        signal,
      ),
    /** What waits for a person: the open items, with the sequence number to follow events from. */
    listInbox: (signal?: AbortSignal) =>
      unary(
        "ListInbox",
        ListInboxRequestSchema,
        ListInboxResponseSchema,
        create(ListInboxRequestSchema, { includeResolved: false }),
        signal,
      ),
    /** Answer an item with one of its choices. `text` is the reason or the reply. */
    answerInbox: (
      itemId: string,
      choice: string,
      text = "",
      signal?: AbortSignal,
    ) =>
      unary(
        "AnswerInbox",
        AnswerInboxRequestSchema,
        InboxItemSchema,
        create(AnswerInboxRequestSchema, { itemId, choice, text }),
        signal,
      ),
    /**
     * A card's activity, oldest first, one page of at most 500 entries: notes, answers and
     * what the stages logged. `afterSeq` is the `seq` of the last entry already read.
     */
    listActivity: (cardId: string, signal?: AbortSignal, afterSeq = 0n) =>
      unary(
        "ListActivity",
        ListActivityRequestSchema,
        ListActivityResponseSchema,
        create(ListActivityRequestSchema, { cardId, afterSeq }),
        signal,
      ),
    /** What agents did: runs, how long they took, and the cards and runs agents started each week. */
    getUsage: (signal?: AbortSignal) =>
      unary(
        "GetUsage",
        GetUsageRequestSchema,
        GetUsageResponseSchema,
        create(GetUsageRequestSchema),
        signal,
      ),
    /** Everyone in the community with the level each acts at, people first and then agents. */
    listAccess: (signal?: AbortSignal) =>
      unary(
        "ListAccess",
        ListAccessRequestSchema,
        ListAccessResponseSchema,
        create(ListAccessRequestSchema),
        signal,
      ),
    /** Set one person's or agent's level. The reply is its entry as it now stands. */
    setAccessLevel: (pubkey: string, level: string, signal?: AbortSignal) =>
      unary(
        "SetAccessLevel",
        SetAccessLevelRequestSchema,
        AccessEntrySchema,
        create(SetAccessLevelRequestSchema, { pubkey, level }),
        signal,
      ),
    /** The intake rules, which any reader may see. */
    listIntakeRules: (signal?: AbortSignal) =>
      unary(
        "ListIntakeRules",
        ListIntakeRulesRequestSchema,
        ListIntakeRulesResponseSchema,
        create(ListIntakeRulesRequestSchema),
        signal,
      ),
    /** Save a rule. An empty `id` adds one; the reply is the rule as stored. */
    saveIntakeRule: (
      rule: MessageInitShape<typeof IntakeRuleSchema>,
      signal?: AbortSignal,
    ) =>
      unary(
        "SaveIntakeRule",
        SaveIntakeRuleRequestSchema,
        IntakeRuleSchema,
        create(SaveIntakeRuleRequestSchema, { rule }),
        signal,
      ),
    deleteIntakeRule: (id: string, signal?: AbortSignal) =>
      unary(
        "DeleteIntakeRule",
        DeleteIntakeRuleRequestSchema,
        DeleteIntakeRuleResponseSchema,
        create(DeleteIntakeRuleRequestSchema, { id }),
        signal,
      ),
    /** Read the host now for one rule, or for every rule when `ruleId` is empty. */
    refreshIntake: (ruleId = "", signal?: AbortSignal) =>
      unary(
        "RefreshIntake",
        RefreshIntakeRequestSchema,
        RefreshIntakeResponseSchema,
        create(RefreshIntakeRequestSchema, { ruleId }),
        signal,
      ),
    /**
     * The issues on the first page of a rule's search that the rule would take. Nothing is
     * stored and no card is added.
     */
    previewIntake: (
      rule: MessageInitShape<typeof IntakeSchema>,
      signal?: AbortSignal,
    ) =>
      unary(
        "PreviewIntake",
        PreviewIntakeRequestSchema,
        PreviewIntakeResponseSchema,
        create(PreviewIntakeRequestSchema, { rule }),
        signal,
      ),
    /** The repos the team's token reaches on github.com, as "owner/name". */
    listRepos: (signal?: AbortSignal) =>
      unary(
        "ListRepos",
        ListReposRequestSchema,
        ListReposResponseSchema,
        create(ListReposRequestSchema, { host: "github.com" }),
        signal,
      ),
    /**
     * Issues of one or more repos, narrowed by text, label, assignee (a login, or `none`) and
     * state. An empty state reads open and closed issues.
     */
    searchIssues: (
      input: {
        repos: string[];
        text?: string;
        label?: string;
        assignee?: string;
        state?: "open" | "closed" | "";
      },
      signal?: AbortSignal,
    ) =>
      unary(
        "SearchIssues",
        SearchIssuesRequestSchema,
        SearchIssuesResponseSchema,
        create(SearchIssuesRequestSchema, {
          host: "github.com",
          filter: {
            repos: input.repos,
            text: input.text ?? "",
            label: input.label ?? "",
            assignee: input.assignee ?? "",
            state: input.state ?? "open",
          },
        }),
        signal,
      ),
    /** The newest comments on a card's issue. Their text is from outside the team. */
    listIssueComments: (cardId: string, signal?: AbortSignal) =>
      unary(
        "ListIssueComments",
        ListIssueCommentsRequestSchema,
        ListIssueCommentsResponseSchema,
        create(ListIssueCommentsRequestSchema, { cardId }),
        signal,
      ),
    /**
     * Ask the assistant's agent. The reply is the job's id at once, and the answer arrives as a
     * `job.result` event. An empty `rootEventId` opens a new thread, whose root the `job.started`
     * event names; a thread's root continues it.
     */
    startChat: (text: string, rootEventId = "", signal?: AbortSignal) =>
      unary(
        "StartChat",
        StartChatRequestSchema,
        StartJobResponseSchema,
        create(StartChatRequestSchema, { text, rootEventId }),
        signal,
      ),
    /** End a running job. The reply so far stays and no `job.result` event follows. */
    cancelJob: (jobId: string, signal?: AbortSignal) =>
      unary(
        "CancelJob",
        CancelJobRequestSchema,
        CancelJobResponseSchema,
        create(CancelJobRequestSchema, { jobId }),
        signal,
      ),
    /** The workflows an agent offered the caller and that are not yet decided, oldest first. */
    listProposals: (signal?: AbortSignal) =>
      unary(
        "ListProposals",
        ListProposalsRequestSchema,
        ListProposalsResponseSchema,
        create(ListProposalsRequestSchema),
        signal,
      ),
    /** Record what the person did with a proposal. It acts on nothing: apply it with `saveWorkflow`. */
    resolveProposal: (
      proposalId: bigint,
      accepted: boolean,
      signal?: AbortSignal,
    ) =>
      unary(
        "ResolveProposal",
        ResolveProposalRequestSchema,
        ResolveProposalResponseSchema,
        create(ResolveProposalRequestSchema, { proposalId, accepted }),
        signal,
      ),
    /** File a ticket an agent proposed: the engine opens its issue and adds the card. */
    acceptTicketProposal: (proposalId: bigint, signal?: AbortSignal) =>
      unary(
        "AcceptTicketProposal",
        AcceptTicketProposalRequestSchema,
        AcceptTicketProposalResponseSchema,
        create(AcceptTicketProposalRequestSchema, { proposalId }),
        signal,
      ),
    /**
     * Every agent that has a folder on the host, each with the tool servers it starts. Needs
     * Read. A server never holds a secret value.
     */
    listAgentToolServers: (signal?: AbortSignal) =>
      unary(
        "ListAgentToolServers",
        ListAgentToolServersRequestSchema,
        ListAgentToolServersResponseSchema,
        create(ListAgentToolServersRequestSchema),
        signal,
      ),
    /**
     * Add a tool server to an agent, or replace the one with its name. `spec` is the whole entry:
     * a command with args, or a url. The change is saved even when the host cannot apply it, and
     * the reply says which happened. Needs Admin.
     */
    setAgentToolServer: (
      agent: string,
      server: { name: string; transport: string; spec: object },
      signal?: AbortSignal,
    ) =>
      unary(
        "SetAgentToolServer",
        SetAgentToolServerRequestSchema,
        AgentToolsChangeSchema,
        create(SetAgentToolServerRequestSchema, {
          agent,
          server: {
            name: server.name,
            transport: server.transport,
            specJson: JSON.stringify(server.spec),
          },
        }),
        signal,
      ),
    /** Take a tool server off an agent and apply the agent. Needs Admin. */
    removeAgentToolServer: (
      agent: string,
      name: string,
      signal?: AbortSignal,
    ) =>
      unary(
        "RemoveAgentToolServer",
        RemoveAgentToolServerRequestSchema,
        AgentToolsChangeSchema,
        create(RemoveAgentToolServerRequestSchema, { agent, name }),
        signal,
      ),
    /** What the engine reports about itself, including the agents that are not set up for stage threads. */
    getHiveHealth: (signal?: AbortSignal) =>
      unary(
        "GetHiveHealth",
        GetHiveHealthRequestSchema,
        GetHiveHealthResponseSchema,
        create(GetHiveHealthRequestSchema),
        signal,
      ),
    getStatus: (signal?: AbortSignal) =>
      unary(
        "GetStatus",
        GetStatusRequestSchema,
        GetStatusResponseSchema,
        create(GetStatusRequestSchema),
        signal,
      ),
  };
}

export type Client = ReturnType<typeof createClient>;
