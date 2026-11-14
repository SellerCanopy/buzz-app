import type { PluginModule } from "../../plugins/api";
import { BeehivePage } from "./BeehivePage";
import { createClient } from "./engine/client";
import { chooseCarrier } from "./engine/carrier";
import { beehiveOrigin } from "./engine/origin";
import { createSession } from "./engine/session";

export const inject = ["pages"];

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
    component: () => <BeehivePage client={client} />,
  });
};
