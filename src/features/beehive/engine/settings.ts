import type { GetSettingsResponse } from "../gen/kiln/engine/v1/engine_pb";

/** The community settings Beehive's own screens read and write. */
export const UPDATE_CHANNEL = "update_channel";
export const ASSISTANT_AGENT = "assistant_agent";

/** The text inside a stored setting value, or "" when none is set or it is not text. */
function textOf(valueJson: string | undefined): string {
  if (!valueJson) return "";
  try {
    const value: unknown = JSON.parse(valueJson);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** The update channel and the assistant agent a settings reply holds, "" for one that is not set. */
export function beehiveSettings(reply: GetSettingsResponse): {
  channel: string;
  agent: string;
} {
  const value = (key: string) =>
    textOf(reply.settings.find((setting) => setting.key === key)?.valueJson);
  return { channel: value(UPDATE_CHANNEL), agent: value(ASSISTANT_AGENT) };
}
