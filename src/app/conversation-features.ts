import type { BundledPlugin } from "../plugins/manager";
import emojiManifest from "../bundled/emoji/manifest.json";
import * as emoji from "../bundled/emoji";
import mentionsManifest from "../bundled/mentions/manifest.json";
import * as mentions from "../bundled/mentions";
import { PLUGIN_REQUEST_REVIEWER } from "../plugins/review-access";
import * as pluginRequests from "./plugin-request-feature";
import * as beehive from "../features/beehive/module";
import { PLUGIN_ID as BEEHIVE_ID } from "../features/beehive/routes";

// Host-owned features use the shared contribution lifecycle, without catalog
// entries or saved enablement. Keep their keys for composer and huddle consumers.
export const conversationFeatures: readonly BundledPlugin[] = [
  { manifest: { ...emojiManifest, apiVersion: 1 }, module: emoji },
  { manifest: { ...mentionsManifest, apiVersion: 1 }, module: mentions },
  {
    manifest: {
      id: PLUGIN_REQUEST_REVIEWER,
      name: "Plugin requests",
      apiVersion: 1,
      description: "Review agents' plugin requests in their conversations.",
    },
    module: pluginRequests,
  },
  {
    manifest: {
      id: BEEHIVE_ID,
      name: "Beehive",
      apiVersion: 1,
      description: "Workflows that run on your agents.",
    },
    module: beehive,
  },
];
