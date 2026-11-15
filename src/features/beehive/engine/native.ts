import { invoke } from "@tauri-apps/api/core";
import { decodeReply, EngineError, NO_ANSWER, type Carrier } from "./transport";

type NativeFailure = { code?: unknown; message?: unknown; status?: unknown };

/** Rust rejects with `{ code, message, status }`, or with a bare string for a local failure. */
function toEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (typeof error === "string")
    return new EngineError("unavailable", error || NO_ANSWER, 0);
  const failure = (error ?? {}) as NativeFailure;
  return new EngineError(
    typeof failure.code === "string" ? failure.code : "unavailable",
    typeof failure.message === "string" && failure.message
      ? failure.message
      : NO_ANSWER,
    typeof failure.status === "number" ? failure.status : 0,
  );
}

/**
 * Reach Beehive through the desktop app. Rust signs the sign-in event with the
 * person's Buzz key and makes the request, so the key never reaches the page.
 */
export function nativeCarrier(): Carrier {
  return {
    async authorize() {
      try {
        return `Nostr ${await invoke<string>("beehive_authorization")}`;
      } catch (error) {
        throw toEngineError(error);
      }
    },
    async post(path, body, opts, signal) {
      signal?.throwIfAborted();
      let text: string;
      try {
        text = await invoke<string>("beehive_request", {
          path,
          body: JSON.stringify(body),
          bearer: opts.bearer ?? null,
          authorization: opts.authorization ?? null,
        });
      } catch (error) {
        throw toEngineError(error);
      }
      signal?.throwIfAborted();
      // The same reading as the web carrier, so a reply that is not a JSON
      // object is an `EngineError` on both.
      return decodeReply(200, "", text);
    },
  };
}
