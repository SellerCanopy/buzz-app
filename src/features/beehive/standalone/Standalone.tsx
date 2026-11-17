import type { ReactNode } from "react";
import { ToastProvider } from "../../../shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../../shared/design-system/useKeyboardFocusVisibility";
import { BeehivePage } from "../BeehivePage";
import { createClient, type Client } from "../engine/client";
import { createSession } from "../engine/session";
import { EngineError, webCarrier } from "../engine/transport";
import { useHistory } from "./history";
import { nativeToken } from "./native";
import { openNativeThread } from "./thread";

/**
 * The page's engine client. The engine serves the page, so its own origin is Beehive's and no
 * address is configured. Every token comes from the app's shim, so the carrier never signs in.
 * There is no relay, Buzz sign-in or identity.
 */
export function standaloneClient(
  origin: string,
  native = nativeToken(),
): Client {
  return createClient(
    createSession(
      webCarrier(origin, async () => {
        throw new EngineError(
          "unauthenticated",
          "Sign-in is not available here",
          0,
        );
      }),
      Date.now,
      native,
    ),
  );
}

// Without a relay a thread is never embedded, so the page never renders this.
const NoThread = (): ReactNode => null;

/** The Beehive page on its own, as the iOS web view loads it. */
export function Standalone({ client }: { client: Client }) {
  useKeyboardFocusVisibility();
  const { navigator, navigation } = useHistory();
  return (
    <ToastProvider>
      <main
        data-buzz-ui=""
        className="text-body"
        style={{ height: "100dvh", boxSizing: "border-box" }}
      >
        <BeehivePage
          client={client}
          navigation={navigation}
          navigator={navigator}
          Thread={NoThread}
          onOpenThread={openNativeThread}
        />
      </main>
    </ToastProvider>
  );
}
