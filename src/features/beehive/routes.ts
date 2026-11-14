import type { JsonValue, OpenTarget } from "../navigation/targets";

export const PLUGIN_ID = "buzz.beehive";
export const PAGE_ID = "beehive";

type PageTarget = Extract<OpenTarget, { kind: "page" }>;

const CARD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The card a route names: `{ card: <uuid> }` and nothing else. */
export function routeCard(value: JsonValue | undefined): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const route = value as Record<string, JsonValue>;
  if (Object.keys(route).length !== 1) return;
  return typeof route.card === "string" && CARD_ID.test(route.card)
    ? route.card
    : undefined;
}

function isBeehive(target: OpenTarget): target is PageTarget {
  return (
    target.kind === "page" &&
    target.pluginId === PLUGIN_ID &&
    target.pageId === PAGE_ID
  );
}

/** The card a visit shows, or undefined for the board. */
export function visitedCard(target: OpenTarget): string | undefined {
  return isBeehive(target) ? routeCard(target.route?.params) : undefined;
}

/** The same page opened on one card. */
export function cardTarget(target: PageTarget, card: string): OpenTarget {
  return { ...target, route: { version: 1, params: { card } } };
}

/** The same page opened on its board. */
export function boardTarget(target: PageTarget): OpenTarget {
  const { route: _route, ...board } = target;
  return board;
}

export function isBeehivePage(target: OpenTarget): target is PageTarget {
  return isBeehive(target);
}
