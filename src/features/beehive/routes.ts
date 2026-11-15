import type { JsonValue, OpenTarget } from "../navigation/targets";

export const PLUGIN_ID = "buzz.beehive";
export const PAGE_ID = "beehive";

type PageTarget = Extract<OpenTarget, { kind: "page" }>;

const CARD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const CARD_TABS = ["live", "steps", "files", "details"] as const;
export type CardTab = (typeof CARD_TABS)[number];

function routeObject(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const route = value as Record<string, JsonValue>;
  // `card` is required and `tab` optional. Any other key makes the route unknown.
  return Object.keys(route).every((key) => key === "card" || key === "tab")
    ? route
    : undefined;
}

/** The card a route names: `{ card: <uuid>, tab? }` and nothing else. */
export function routeCard(value: JsonValue | undefined): string | undefined {
  const route = routeObject(value);
  if (!route) return;
  if (route.tab !== undefined && !routeTab(value)) return;
  return typeof route.card === "string" && CARD_ID.test(route.card)
    ? route.card
    : undefined;
}

/** The page's route contract: the one validator the page registers and the tests use. */
export const PAGE_ROUTE = {
  version: 1,
  validate: (params: JsonValue) => !!routeCard(params),
} as const;

/** The tab a route names, or undefined when it names none or an unknown one. */
export function routeTab(value: JsonValue | undefined): CardTab | undefined {
  const tab = routeObject(value)?.tab;
  return CARD_TABS.find((known) => known === tab);
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

/** The tab a visit shows, or undefined for the card's own default. */
export function visitedTab(target: OpenTarget): CardTab | undefined {
  return isBeehive(target) ? routeTab(target.route?.params) : undefined;
}

/** The same page opened on one card, and on one of its tabs when given. */
export function cardTarget(
  target: PageTarget,
  card: string,
  tab?: CardTab,
): OpenTarget {
  return {
    ...target,
    route: { version: 1, params: tab ? { card, tab } : { card } },
  };
}

/** The same page opened on its board. */
export function boardTarget(target: PageTarget): OpenTarget {
  const { route: _route, ...board } = target;
  return board;
}

export function isBeehivePage(target: OpenTarget): target is PageTarget {
  return isBeehive(target);
}
