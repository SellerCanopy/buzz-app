import {
  create,
  fromJson,
  toJson,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  GetStatusRequestSchema,
  GetStatusResponseSchema,
  ListCardsRequestSchema,
  ListCardsResponseSchema,
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
