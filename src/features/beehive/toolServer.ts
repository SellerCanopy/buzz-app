import type { AgentToolServer } from "./gen/kiln/engine/v1/engine_pb";

export type Transport = "stdio" | "http";

/** What the add and edit form holds. The engine's `spec_json` is built from it. */
export type ToolServerForm = {
  name: string;
  transport: Transport;
  /** A stdio server's command and arguments on one line. */
  command: string;
  /** An http server's address. */
  url: string;
};

export type Problems = Partial<Record<"name" | "command" | "url", string>>;

/** The most tool servers one agent may have, as the engine counts them. */
export const MAX_SERVERS = 32;
/** The engine's rule for a name: it becomes a key in the agent's `mcp.json`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const SECRET_MESSAGE =
  "This looks like a secret. Secrets come in a later phase, so a tool server cannot hold one yet.";

/** A word in a flag, a variable or a query key that says its value is a secret. */
const SECRET_WORD = /token|secret|passw(or)?d|api[-_]?key|credential/i;
/** The shape of a key some services hand out, and a bearer header. */
const SECRET_SHAPE =
  /(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16})|\bbearer\s+\S/i;

const isReference = (text: string) => text.includes("${");
/** A flag or variable name that says its value is a secret, as `--token`, not `--token-file`. */
const secretName = (name: string) =>
  SECRET_WORD.test(name) && !/(file|path|url)$/i.test(name);

/** Words and quoted phrases of a command line, or none when a quote is left open. */
export function splitCommand(text: string): string[] | undefined {
  const parts: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) parts.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) parts.push(word);
  return parts;
}

/** The command line `splitCommand` reads back as `parts`. */
export function joinCommand(parts: readonly string[]): string {
  return parts
    .map((part) =>
      part === "" || /[\s"']/.test(part)
        ? part
            .split('"')
            .map((piece) => `"${piece}"`)
            .join("'\"'")
        : part,
    )
    .join(" ");
}

function specOf(server: AgentToolServer): Record<string, unknown> {
  try {
    const spec: unknown = JSON.parse(server.specJson);
    return typeof spec === "object" && spec !== null && !Array.isArray(spec)
      ? (spec as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const transportOf = (server: AgentToolServer): Transport =>
  server.transport === "http" ? "http" : "stdio";

/** The fields the form edits, read from a server the engine listed. */
export function formOf(server: AgentToolServer): ToolServerForm {
  const spec = specOf(server);
  const args = Array.isArray(spec.args)
    ? spec.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return {
    name: server.name,
    transport: transportOf(server),
    command: joinCommand(
      typeof spec.command === "string" ? [spec.command, ...args] : args,
    ),
    url: typeof spec.url === "string" ? spec.url : "",
  };
}

/** One line saying what the server runs or where it is. */
export function describe(server: AgentToolServer): string {
  const form = formOf(server);
  return form.transport === "http"
    ? `Hosted server at ${form.url}`
    : `Runs ${form.command}`;
}

/** The env or headers entries a server holds beside what the form edits, by name. */
function kept(
  server: AgentToolServer | undefined,
  transport: Transport,
): { key: "env" | "headers"; entries: Record<string, unknown> } | undefined {
  if (!server || transportOf(server) !== transport) return undefined;
  const key = transport === "http" ? "headers" : "env";
  const entries = specOf(server)[key];
  return typeof entries === "object" &&
    entries !== null &&
    Object.keys(entries).length > 0
    ? { key, entries: entries as Record<string, unknown> }
    : undefined;
}

/** What a saved server holds that the form does not show, as a sentence, or none. */
export function keptNote(
  server: AgentToolServer | undefined,
  transport: Transport,
) {
  const found = kept(server, transport);
  if (!found) return undefined;
  const names = Object.keys(found.entries).join(", ");
  return found.key === "env"
    ? `Keeps its environment entries: ${names}.`
    : `Keeps its headers: ${names}.`;
}

/**
 * The whole spec to send. Saving a server replaces the entry, so the references a saved server
 * holds in `env` or `headers` are carried over while its transport stays the same.
 */
export function specFor(
  form: ToolServerForm,
  previous?: AgentToolServer,
): Record<string, unknown> {
  const extra = kept(previous, form.transport);
  const holds = extra ? { [extra.key]: extra.entries } : {};
  if (form.transport === "http") return { url: form.url.trim(), ...holds };
  const [command = "", ...args] = splitCommand(form.command) ?? [];
  return { command, ...(args.length > 0 ? { args } : {}), ...holds };
}

function argsLookSecret(parts: readonly string[]): boolean {
  return parts.some((part, at) => {
    if (SECRET_SHAPE.test(part)) return true;
    const equals = part.indexOf("=");
    if (equals > 0)
      return (
        secretName(part.slice(0, equals)) &&
        part.length > equals + 1 &&
        !isReference(part)
      );
    const next = parts[at + 1];
    return (
      /^-{1,2}[\w-]+$/.test(part) &&
      secretName(part) &&
      next !== undefined &&
      !next.startsWith("-") &&
      !isReference(next)
    );
  });
}

function urlLooksSecret(url: URL, text: string): boolean {
  if (url.username || url.password || SECRET_SHAPE.test(text)) return true;
  return [...url.searchParams].some(
    ([key, value]) => secretName(key) && value && !isReference(value),
  );
}

/**
 * What stops the form from saving. `taken` is the names the agent already has. A name is fixed
 * once saved, so it is checked only for a new server. The engine checks the rest and its
 * answer is shown as it gives it.
 */
export function check(
  form: ToolServerForm,
  taken: readonly string[],
  isNew: boolean,
): Problems {
  const problems: Problems = {};
  const name = form.name.trim();
  if (isNew) {
    if (!name) problems.name = "Enter a name for the tool server.";
    else if (!NAME.test(name))
      problems.name =
        "Use letters, digits, _ . or -, up to 64, and start with a letter or digit.";
    else if (taken.includes(name))
      problems.name = "This agent already has a tool server with that name.";
    else if (taken.length >= MAX_SERVERS)
      problems.name = `An agent may have at most ${MAX_SERVERS} tool servers.`;
  }
  if (form.transport === "stdio") {
    const parts = splitCommand(form.command);
    if (!parts) problems.command = "Close the quote in the command.";
    else if (parts.length === 0)
      problems.command = "Enter the command that starts the server.";
    else if (argsLookSecret(parts)) problems.command = SECRET_MESSAGE;
  } else {
    const text = form.url.trim();
    let url: URL | undefined;
    try {
      url = new URL(text);
    } catch {
      url = undefined;
    }
    if (!url || !/^https?:\/\//i.test(text) || /\s/.test(text))
      problems.url = "Use an http:// or https:// address.";
    else if (urlLooksSecret(url, text)) problems.url = SECRET_MESSAGE;
  }
  return problems;
}
