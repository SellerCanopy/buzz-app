import type { PluginModule } from "../../plugins/api";
import { BeehivePage } from "./BeehivePage";
import { createClient } from "./engine/client";
import { chooseCarrier } from "./engine/carrier";
import { beehiveOrigin } from "./engine/origin";
import { createSession } from "./engine/session";
import { routeCard } from "./routes";

export const inject = ["pages", "navigation", "relay", "conversation"];

/** Beehive is off, with no dock entry, until a build gives it an address. */
export const apply: PluginModule["apply"] = (ctx) => {
  const origin = beehiveOrigin();
  if (!origin) return;
  const client = createClient(createSession(chooseCarrier(origin)));
  ctx.pages.register({
    id: "beehive",
    title: "Beehive",
    layout: "workspace",
    primary: true,
    placement: "dock",
    route: { version: 1, validate: (params) => !!routeCard(params) },
    component: (props) => (
      <BeehivePage
        client={client}
        relay={ctx.relay}
        navigation={props.navigation}
        navigator={ctx.navigation}
        Thread={ctx.conversation.ui.Thread}
      />
    ),
  });
};
