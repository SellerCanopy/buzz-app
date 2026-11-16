import { isTauri } from "@tauri-apps/api/core";
import { nativeCarrier } from "./native";
import { EngineError, webCarrier, type Carrier } from "./transport";

/**
 * The carrier for this build, chosen once. The desktop app signs in Rust; a
 * browser has no signer here, so its carrier cannot sign in.
 */
export function chooseCarrier(
  origin: string,
  desktop: boolean = isTauri(),
): Carrier {
  return desktop
    ? nativeCarrier()
    : webCarrier(origin, async () => {
        throw new EngineError(
          "unauthenticated",
          "Sign-in is not available here",
          0,
        );
      });
}
