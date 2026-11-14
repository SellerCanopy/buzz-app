/**
 * Parse a Beehive address. Beehive is off when the value is empty. Otherwise it
 * must be a bare origin: `https:`, or `http:` on localhost in development.
 * Returns `undefined` for off and for an address that is refused.
 */
export function parseBeehiveOrigin(
  value: string | undefined,
  development: boolean,
): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  try {
    const url = new URL(text);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const secure =
      url.protocol === "https:" ||
      (development && local && url.protocol === "http:");
    const bare =
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "";
    if (secure && bare) return url.origin;
  } catch {
    // Fall through to the warning.
  }
  console.warn(
    "Beehive is off: VITE_BUZZ_BEEHIVE_URL must be an https origin with no path.",
  );
  return undefined;
}

/** The configured Beehive origin, or `undefined` when Beehive is off. */
export function beehiveOrigin(): string | undefined {
  return parseBeehiveOrigin(
    import.meta.env.VITE_BUZZ_BEEHIVE_URL as string | undefined,
    import.meta.env.DEV,
  );
}
