import {
  create,
  fromJson,
  toJson,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  AccessEntrySchema,
  AddNoteRequestSchema,
  AddNoteResponseSchema,
  ArtifactVersionSchema,
  ArchiveCardsRequestSchema,
  ArchiveCardsResponseSchema,
  AnswerInboxRequestSchema,
  CardSchema,
  InboxItemSchema,
  CheckWorkflowRequestSchema,
  CheckWorkflowResponseSchema,
  CreateCardRequestSchema,
  CreateTaskRequestSchema,
  GetCardRequestSchema,
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
  ListInboxRequestSchema,
  ListInboxResponseSchema,
  ListRunsRequestSchema,
  ListRunsResponseSchema,
  ListWorkflowsRequestSchema,
  ListWorkflowsResponseSchema,
  PollEventsRequestSchema,
  PollEventsResponseSchema,
  ReadArtifactRequestSchema,
  ResumeCardRequestSchema,
  RestoreCardRequestSchema,
  RetryRunRequestSchema,
  RunSchema,
  SetAccessLevelRequestSchema,
  SetAutoModeRequestSchema,
  SetSettingRequestSchema,
  SettingSchema,
  StartStageRequestSchema,
  StopRunRequestSchema,
  WhoAmIRequestSchema,
  WhoAmIResponseSchema,
} from "../gen/kiln/engine/v1/engine_pb";
import type { Session } from "./session";

const SERVICE = "/kiln.engine.v1.EngineService/";

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
      input: { title: string; description?: string; workflow?: string },
      signal?: AbortSignal,
    ) =>
      unary(
        "CreateCard",
        CreateCardRequestSchema,
        CardSchema,
        create(CreateCardRequestSchema, input),
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
    /** A card's runs, newest first. */
    listRuns: (cardId: string, signal?: AbortSignal) =>
      unary(
        "ListRuns",
        ListRunsRequestSchema,
        ListRunsResponseSchema,
        create(ListRunsRequestSchema, { cardId }),
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
