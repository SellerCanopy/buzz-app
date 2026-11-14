import { invoke } from "@tauri-apps/api/core";
import { EngineError, type Carrier } from "./transport";

type NativeFailure = { code?: unknown; message?: unknown; status?: unknown };

/** Rust rejects with `{ code, message, status }`, or with a bare string for a local failure. */
function toEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (typeof error === "string")
    return new EngineError("unavailable", error, 0);
  const failure = (error ?? {}) as NativeFailure;
  return new EngineError(
    typeof failure.code === "string" ? failure.code : "unavailable",
    typeof failure.message === "string"
      ? failure.message
      : "Beehive did not answer",
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
      return text ? JSON.parse(text) : {};
    },
  };
}
