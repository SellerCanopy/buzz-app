import { isTauri } from "@tauri-apps/api/core";
import { nativeCarrier } from "./native";
import type { Carrier } from "./transport";
import { webCarrier } from "./transport";
import { webAuthorization } from "./web-signer";

/**
 * The carrier for this build, chosen once. The desktop app signs in Rust; the
 * web build signs with the injected web signer.
 */
export function chooseCarrier(
  origin: string,
  desktop: boolean = isTauri(),
): Carrier {
  return desktop
    ? nativeCarrier()
    : webCarrier(origin, () => webAuthorization(origin));
}
