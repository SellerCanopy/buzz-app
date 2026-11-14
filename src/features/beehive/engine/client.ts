import {
  create,
  fromJson,
  toJson,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  AddNoteRequestSchema,
  AddNoteResponseSchema,
  ArchiveCardsRequestSchema,
  ArchiveCardsResponseSchema,
  CardSchema,
  CheckWorkflowRequestSchema,
  CheckWorkflowResponseSchema,
  CreateCardRequestSchema,
  CreateTaskRequestSchema,
  GetCardRequestSchema,
  GetSettingsRequestSchema,
  GetSettingsResponseSchema,
  GetStatusRequestSchema,
  GetStatusResponseSchema,
  ListCardsRequestSchema,
  ListCardsResponseSchema,
  ListStageTemplatesRequestSchema,
  ListStageTemplatesResponseSchema,
  ListTemplateVariablesRequestSchema,
  ListTemplateVariablesResponseSchema,
  ListWorkflowsRequestSchema,
  ListWorkflowsResponseSchema,
  PollEventsRequestSchema,
  PollEventsResponseSchema,
  RemoveCardRequestSchema,
  RemoveCardResponseSchema,
  RestoreCardRequestSchema,
  RunSchema,
  SetSettingRequestSchema,
  SettingSchema,
  StartStageRequestSchema,
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
    removeCard: (cardId: string, signal?: AbortSignal) =>
      unary(
        "RemoveCard",
        RemoveCardRequestSchema,
        RemoveCardResponseSchema,
        create(RemoveCardRequestSchema, { cardId }),
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
    /** Check one package by name, or every package and folder when `name` is empty. */
    checkWorkflow: (name = "", signal?: AbortSignal) =>
      unary(
        "CheckWorkflow",
        CheckWorkflowRequestSchema,
        CheckWorkflowResponseSchema,
        create(CheckWorkflowRequestSchema, { name }),
        signal,
      ),
    listTemplateVariables: (signal?: AbortSignal) =>
      unary(
        "ListTemplateVariables",
        ListTemplateVariablesRequestSchema,
        ListTemplateVariablesResponseSchema,
        create(ListTemplateVariablesRequestSchema),
        signal,
      ),
    listStageTemplates: (signal?: AbortSignal) =>
      unary(
        "ListStageTemplates",
        ListStageTemplatesRequestSchema,
        ListStageTemplatesResponseSchema,
        create(ListStageTemplatesRequestSchema),
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
