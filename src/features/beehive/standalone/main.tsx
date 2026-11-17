import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../../shared/styles/globals.css";
import { useKeyboardFocusVisibility } from "../../../shared/design-system/useKeyboardFocusVisibility";
import { BeehivePage } from "../BeehivePage";
import { createClient } from "../engine/client";
import { createSession } from "../engine/session";
import { EngineError, webCarrier } from "../engine/transport";
import { useHistory } from "./history";
import { openNativeThread } from "./thread";

// The engine serves this page, so its own origin is Beehive's and no address is configured. The
// iOS web view injects `window.__beehiveNative` before the page loads, and the session asks it
// for every token, so this carrier never signs in. There is no relay, Buzz sign-in or identity.
const client = createClient(
  createSession(
    webCarrier(location.origin, async () => {
      throw new EngineError(
        "unauthenticated",
        "Sign-in is not available here",
        0,
      );
    }),
  ),
);

// Without a relay a thread is never embedded, so the page never renders this.
const NoThread = (): ReactNode => null;

function Standalone() {
  useKeyboardFocusVisibility();
  const { navigator, navigation } = useHistory();
  return (
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
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Standalone />
    </StrictMode>,
  );
