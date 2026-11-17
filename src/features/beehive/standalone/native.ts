import type { NativeToken } from "../engine/session";
import { EngineError } from "../engine/transport";

/** How long the first call waits for the app to inject its shim, and how often it looks. */
export const SHIM_WAIT_MS = 3_000;
const SHIM_POLL_MS = 50;

/** Resolves with `window.__beehiveNative` once it exists, or `undefined` after `waitMs`. */
function shim(waitMs: number): Promise<NativeToken | undefined> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const found = window.__beehiveNative;
      if (found || Date.now() - started >= waitMs) resolve(found);
      else setTimeout(look, SHIM_POLL_MS);
    };
    look();
  });
}

/**
 * The page's token source. The app injects its shim shortly after the page starts, so a call
 * that comes first waits for it a moment instead of failing. Once it has appeared every call
 * reaches it at once. If it never appears the call fails as unavailable, which the page shows
 * with a retry, rather than as a refused sign-in.
 */
export function nativeToken(waitMs: number = SHIM_WAIT_MS): NativeToken {
  return {
    async token(options) {
      const found = await shim(waitMs);
      if (!found)
        throw new EngineError(
          "unavailable",
          "Beehive can only be opened from the Buzz app",
          0,
        );
      return found.token(options);
    },
  };
}
