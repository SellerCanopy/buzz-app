import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../shared/styles/globals.css";
import { Button } from "../../shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
import { BeehivePage } from "./BeehivePage";
import { createClient } from "./engine/client";
import { createSession } from "./engine/session";
import { EngineError, type Carrier, webCarrier } from "./engine/transport";
import { provideWebSigner, webAuthorization } from "./engine/web-signer";

// An offline Beehive. `listCardsFailures` is how many ListCards calls fail
// before one succeeds; a journey sets it with `addInitScript`.
type Fixture = { listCardsFailures: number; calls: string[] };
const fixture: Fixture = Object.assign(
  { listCardsFailures: 0, calls: [] as string[] },
  (window as unknown as { beehiveFixture?: Partial<Fixture> }).beehiveFixture,
);
Object.assign(window, { beehiveFixture: fixture });

const carrier: Carrier = {
  authorize: async () => "Nostr fixture",
  async post(path, _body, opts, signal) {
    // Like fetch, a call that was abandoned before it started never happens.
    signal?.throwIfAborted();
    fixture.calls.push(
      `${path} ${opts.bearer ? `bearer ${opts.bearer}` : (opts.authorization ?? "")}`.trim(),
    );
    if (path === "/auth/token")
      return { token: "fixture-token", expires_at: Date.now() / 1000 + 900 };
    if (fixture.listCardsFailures > 0) {
      fixture.listCardsFailures -= 1;
      throw new EngineError("unavailable", "Beehive is not reachable", 0);
    }
    return {};
  },
};
// `?hive=<origin>` points the page at a real engine and signs with the fixed
// test key, for e2e/board.spec.mjs. It is never reachable from the app.
const hive = new URLSearchParams(location.search).get("hive");
if (hive) {
  const { testSigner } = await import("./e2e/signer");
  provideWebSigner(testSigner);
}
const client = createClient(
  createSession(
    hive ? webCarrier(hive, () => webAuthorization(hive)) : carrier,
  ),
);

function Fixture() {
  useKeyboardFocusVisibility();
  return (
    <main
      data-buzz-ui=""
      className="text-body"
      style={{ padding: 24, height: "100vh", boxSizing: "border-box" }}
    >
      <Button
        onClick={() => {
          document.documentElement.dataset.colorMode =
            document.documentElement.dataset.colorMode === "dark"
              ? "light"
              : "dark";
        }}
      >
        Toggle appearance
      </Button>
      <div style={{ height: "calc(100% - 48px)", marginTop: 12 }}>
        <BeehivePage client={client} />
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
