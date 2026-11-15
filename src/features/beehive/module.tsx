import type { Context } from "@deepseek-ai/cordis";
import type { PluginModule } from "../../plugins/api";
import { BeehivePage } from "./BeehivePage";
import { createClient } from "./engine/client";
import { chooseCarrier } from "./engine/carrier";
import { beehiveOrigin } from "./engine/origin";
import { createSession } from "./engine/session";
import { createLevelStore, showsDock } from "./level";
import { PAGE_ID, PAGE_ROUTE } from "./routes";

export const inject = ["pages", "navigation", "relay", "conversation"];

/** Beehive is off, with no dock entry, until a build gives it an address. */
export const apply: PluginModule["apply"] = (ctx) => {
  const origin = beehiveOrigin();
  if (!origin) return;
  const client = createClient(createSession(chooseCarrier(origin)));
  const level = createLevelStore(client);
  ctx.effect(() => level.start(), "Beehive level");
  // The page registers in its own scope, so the entry can leave the dock when the level
  // drops to None and return when it rises again.
  ctx.effect(() => {
    let dock: { dispose(): Promise<void> } | undefined;
    const sync = () => {
      if (showsDock(level.get())) {
        dock ??= ctx.plugin({
          inject: ["pages"],
          apply: (scope: Context) => registerPage(scope, client, level),
        });
      } else if (dock) {
        void dock.dispose();
        dock = undefined;
      }
    };
    sync();
    const unsubscribe = level.subscribe(sync);
    return () => {
      unsubscribe();
      void dock?.dispose();
    };
  }, "Beehive dock entry");
};

function registerPage(
  scope: Context,
  client: ReturnType<typeof createClient>,
  level: ReturnType<typeof createLevelStore>,
) {
  scope.pages.register({
    id: PAGE_ID,
    title: "Beehive",
    layout: "workspace",
    primary: true,
    placement: "dock",
    route: PAGE_ROUTE,
    component: (props) => (
      <BeehivePage
        client={client}
        level={level}
        relay={scope.relay}
        navigation={props.navigation}
        navigator={scope.navigation}
        Thread={scope.conversation.ui.Thread}
      />
    ),
  });
}
