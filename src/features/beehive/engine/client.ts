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
  CreateCardRequestSchema,
  CreateTaskRequestSchema,
  GetCardRequestSchema,
  GetStatusRequestSchema,
  GetStatusResponseSchema,
  ListCardsRequestSchema,
  ListCardsResponseSchema,
  PollEventsRequestSchema,
  PollEventsResponseSchema,
  RemoveCardRequestSchema,
  RemoveCardResponseSchema,
  RestoreCardRequestSchema,
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
    whoAmI: (signal?: AbortSignal) =>
      unary(
        "WhoAmI",
        WhoAmIRequestSchema,
        WhoAmIResponseSchema,
        create(WhoAmIRequestSchema),
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
