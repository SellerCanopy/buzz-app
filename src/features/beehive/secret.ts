import type { SecretApplied } from "./gen/kiln/engine/v1/engine_pb";

/** The most secrets one agent may hold, its own and the team secrets granted to it together. */
export const MAX_SECRETS = 64;
/** The longest value, in bytes. */
export const MAX_VALUE_BYTES = 4096;
const MAX_NAME_CHARS = 64;

/** The engine's rule for a name: it becomes an environment variable in the agent. */
const NAME = /^[A-Z][A-Z0-9_]*$/;
/** Names the deploy sets itself start with these, so a secret may not shadow them. */
const RESERVED_PREFIXES = [
  "BUZZ_",
  "CLAUDE",
  "ANTHROPIC_",
  "OPENAI_",
  "CODEX_",
];
/** Variables every agent container already has. */
const AMBIENT = ["HOME", "PATH", "PWD", "USER", "SHELL"];
/** The characters the agents' env file takes unquoted: no space, quote, `$` or line break. */
const VALUE = /^[A-Za-z0-9.:_~+/=@-]+$/;

export const NO_READ_BACK = "A value cannot be read back, only replaced.";

/** What is wrong with a secret's name, or nothing. The engine decides the rest. */
export function checkName(raw: string): string | undefined {
  const name = raw.trim();
  if (!name) return "Enter a name for the secret.";
  if (name.length > MAX_NAME_CHARS || !NAME.test(name))
    return `Use capital letters, digits and _, starting with a letter, up to ${MAX_NAME_CHARS} characters.`;
  if (
    AMBIENT.includes(name) ||
    RESERVED_PREFIXES.some((p) => name.startsWith(p))
  )
    return `${name} is reserved: the deploy sets names starting with ${RESERVED_PREFIXES.join(", ")} and the container sets ${AMBIENT.join(", ")}.`;
  return undefined;
}

/** What is wrong with a value, or nothing. The text never repeats the value. */
export function checkValue(value: string): string | undefined {
  if (!value) return "Enter the value.";
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES)
    return `A value may be at most ${MAX_VALUE_BYTES} bytes.`;
  if (!VALUE.test(value))
    return "A value may hold only letters, digits and . _ ~ + / = : @ - (the value is not shown).";
  return undefined;
}

/** Whether an agent already holding `held` secrets may be given one more. */
export function checkRoom(held: number): string | undefined {
  return held >= MAX_SECRETS
    ? `An agent may have at most ${MAX_SECRETS} secrets.`
    : undefined;
}

/** `a`, `a and b`, `a, b and c`. */
export function list(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Capitalizes the engine's reason and ends it with one full stop. */
function sentence(text: string): string {
  const reason = text.trim().replace(/[.!?\s]+$/, "");
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

/** What a change did to the agents it reached, as the engine reported it. */
export type Reached = {
  /** The sentence that says what was done, such as "Saved GH_TOKEN." */
  done: string;
  /** Agents that have the change and restarted because of it. */
  restarted: string[];
  /** Agents that have the change and did not need to restart. */
  unchanged: string[];
  /** Agents that do not have the change yet, with the host's reason. */
  failed: { agent: string; reason: string }[];
};

/** Sorts each agent of a reply by what happened to it. */
export function reached(
  done: string,
  results: readonly SecretApplied[],
): Reached {
  return {
    done,
    restarted: results
      .filter((r) => r.applied && r.restarted)
      .map((r) => r.agent),
    unchanged: results
      .filter((r) => r.applied && !r.restarted)
      .map((r) => r.agent),
    failed: results
      .filter((r) => !r.applied)
      .map((r) => ({
        agent: r.agent,
        reason: sentence(r.applyError || "Beehive's host did not apply it"),
      })),
  };
}

/** The status line for the agents that have the change, or none when no agent does. */
export function appliedLine(change: Reached): string {
  const parts = [change.done];
  if (change.restarted.length > 0)
    parts.push(
      `${list(change.restarted)} restarted, and a restarted agent restarts the work it is doing now.`,
    );
  if (change.unchanged.length > 0)
    parts.push(`${list(change.unchanged)} did not need to restart.`);
  if (
    change.restarted.length === 0 &&
    change.unchanged.length === 0 &&
    change.failed.length === 0
  )
    parts.push("No agent holds it yet, so no agent changed.");
  return parts.join(" ");
}
