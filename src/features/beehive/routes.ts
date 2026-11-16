import type { JsonValue, OpenTarget } from "../navigation/targets";

export const PLUGIN_ID = "buzz.beehive";
export const PAGE_ID = "beehive";

type PageTarget = Extract<OpenTarget, { kind: "page" }>;

const CARD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const CARD_TABS = [
  "live",
  "steps",
  "files",
  "activity",
  "issue",
  "repos",
  "details",
] as const;
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

/** What a package name may be. The engine applies the same rule when it saves one. */
export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The rule in words, for a name that does not match it. */
export const NAME_RULE =
  "Use lowercase letters, digits, - and _, starting with a letter or digit, up to 32 characters.";

function only(
  value: JsonValue | undefined,
  key: string,
): JsonValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key
    ? (value as Record<string, JsonValue>)[key]
    : undefined;
}

/** The workflow a route opens in the editor: `{ workflow: <name> }` and nothing else. */
export function routeWorkflow(
  value: JsonValue | undefined,
): string | undefined {
  const name = only(value, "workflow");
  return typeof name === "string" && WORKFLOW_NAME.test(name)
    ? name
    : undefined;
}

/** True for the route of the new workflow page: `{ newWorkflow: true }` and nothing else. */
export function routeNewWorkflow(value: JsonValue | undefined): boolean {
  return only(value, "newWorkflow") === true;
}

/** True for the route of the assistant panel: `{ assistant: true }` and nothing else. */
export function routeAssistant(value: JsonValue | undefined): boolean {
  return only(value, "assistant") === true;
}

/** The page's route contract: the one validator the page registers and the tests use. */
export const PAGE_ROUTE = {
  version: 1,
  validate: (params: JsonValue) =>
    !!routeCard(params) ||
    !!routeWorkflow(params) ||
    routeNewWorkflow(params) ||
    routeAssistant(params),
} as const;

/** The tab a route names, or undefined when it names none or an unknown one. */
export function routeTab(value: JsonValue | undefined): CardTab | undefined {
  const tab = routeObject(value)?.tab;
  return CARD_TABS.find((known) => known === tab);
}

/** True for a visit of the Beehive page. */
export function isBeehivePage(target: OpenTarget): target is PageTarget {
  return (
    target.kind === "page" &&
    target.pluginId === PLUGIN_ID &&
    target.pageId === PAGE_ID
  );
}

/** The card a visit shows, or undefined for the board. */
export function visitedCard(target: OpenTarget): string | undefined {
  return isBeehivePage(target) ? routeCard(target.route?.params) : undefined;
}

/** The tab a visit shows, or undefined for the card's own default. */
export function visitedTab(target: OpenTarget): CardTab | undefined {
  return isBeehivePage(target) ? routeTab(target.route?.params) : undefined;
}

/** The workflow a visit edits, or undefined when it edits none. */
export function visitedWorkflow(target: OpenTarget): string | undefined {
  return isBeehivePage(target)
    ? routeWorkflow(target.route?.params)
    : undefined;
}

/** True when a visit shows the page that adds a workflow. */
export function visitedNewWorkflow(target: OpenTarget): boolean {
  return isBeehivePage(target) && routeNewWorkflow(target.route?.params);
}

/** True when a visit shows the assistant panel over the view a person chose. */
export function visitedAssistant(target: OpenTarget): boolean {
  return isBeehivePage(target) && routeAssistant(target.route?.params);
}

/** The same page opened on the assistant panel. */
export function assistantTarget(target: PageTarget): OpenTarget {
  return { ...target, route: { version: 1, params: { assistant: true } } };
}

/** The same page opened on the editor of one workflow. */
export function workflowTarget(target: PageTarget, name: string): OpenTarget {
  return { ...target, route: { version: 1, params: { workflow: name } } };
}

/** The same page opened on the page that adds a workflow. */
export function newWorkflowTarget(target: PageTarget): OpenTarget {
  return { ...target, route: { version: 1, params: { newWorkflow: true } } };
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
