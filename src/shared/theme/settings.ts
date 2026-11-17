import type { DeviceSetting } from "../device-settings";
import { ACCENTS, type Accent, type Contrast } from "./accent";
import {
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  THEMES,
  type Appearance,
  type ColorModePreference,
  type MessageDensity,
  type Theme,
} from "./service";

/** Appearance as device settings, through the one live `appearance`. */
export function appearanceSettings(appearance: Appearance): DeviceSetting[] {
  const live = () => !appearance.isDisposed();
  const now = () => appearance.snapshot();
  return [
    {
      key: "appearance.mode",
      description:
        "Light or dark, or follow the system. Always light while the Beehive theme is on.",
      schema: { type: "string", enum: ["system", "light", "dark"] },
      read: () => ({ value: now().preference, unsaved: now().error }),
      write: (value) => {
        if (now().modeLocked)
          throw new Error(
            "Mode is Light while Beehive is on. Set appearance.theme to buzz first.",
          );
        appearance.setMode(value as ColorModePreference);
      },
      live,
    },
    {
      key: "appearance.theme",
      description:
        "Color theme. Beehive recolors the app in warm yellow and is light only: it sets Mode to Light, and Buzz restores the earlier mode.",
      schema: { type: "string", enum: THEMES },
      read: () => ({ value: now().theme, unsaved: now().themeError }),
      write: (value) => appearance.setTheme(value as Theme),
      live,
    },
    {
      key: "appearance.interface_size",
      description: "Text and interface size, in percent.",
      schema: {
        type: "integer",
        minimum: Math.round(MIN_FONT_SCALE * 100),
        maximum: Math.round(MAX_FONT_SCALE * 100),
        multipleOf: 10,
      },
      read: () => ({
        value: Math.round(now().fontScale * 100),
        unsaved: now().fontError,
      }),
      write: (value) => appearance.setFontScale((value as number) / 100),
      live,
    },
    {
      key: "appearance.accent",
      description:
        "Accent color for messages, send and selected rows. Beehive always uses Honey; a choice made while it is on is kept for Buzz.",
      schema: { type: "string", enum: ACCENTS },
      read: () => ({ value: now().accent, unsaved: now().accentError }),
      write: (value) => appearance.setAccent(value as Accent),
      live,
    },
    {
      key: "appearance.vibe",
      description: "Vibe level: low is Chillin’, high is Buzzin’.",
      schema: { type: "string", enum: ["low", "high"] },
      read: () => ({ value: now().contrast, unsaved: now().contrastError }),
      write: (value) => appearance.setContrast(value as Contrast),
      live,
    },
    {
      key: "conversations.message_density",
      description: "Message density: compact is a flat list of messages.",
      schema: { type: "string", enum: ["default", "compact"] },
      read: () => ({ value: now().density, unsaved: now().densityError }),
      write: (value) => appearance.setDensity(value as MessageDensity),
      live,
    },
  ];
}
