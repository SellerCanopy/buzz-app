import { beforeEach, expect, it, vi } from "vitest";
import type { AgentStore } from "../../features/agents/store";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeAuth } from "./auth";
import { ENV, type Spawn } from "./claude";

const KEY = "sk-ant-api03-saved";

/** Native's key store (`claude_key.rs`): whether a key is saved, the asks
 * and saves it took, and a refusal to answer the next save with. */
const state = vi.hoisted(() => ({
  saved: true,
  asked: 0,
  saves: [] as string[],
  clears: 0,
  refusals: [] as string[],
  /** Secure storage refuses to say whether a key is saved. */
  unreadable: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (command: string, args?: { value: string }) => {
    if (command === "claude_api_key_status") {
      state.asked += 1;
      if (state.unreadable) throw "Secure storage is unavailable";
      return state.saved;
    }
    if (command === "claude_api_key_clear") {
      state.clears++;
      const refusal = state.refusals.shift();
      if (refusal) throw refusal;
      state.saved = false;
      return null;
    }
    if (command !== "claude_api_key_set" || !args) return null;
    const refusal = state.refusals.shift();
    if (refusal) throw refusal;
    state.saves.push(args.value);
    state.saved = true;
    return null;
  },
}));
/** Starts with a key saved or not. */
function store(saved = true) {
  Object.assign(state, {
    saved,
    asked: 0,
    saves: [],
    clears: 0,
    refusals: [],
    unreadable: false,
  });
}
beforeEach(() => void store());

/** A host whose `claude.sh review` prints a review folder, and whose
 * `claude auth status` reports `own`, the person's own setup (signed out
 * unless set); every start but that check is recorded. */
function host(own: Record<string, unknown> = { loggedIn: false }) {
  const started: { id: string; options: HostProcessOptions | undefined }[] = [];
  const status = { own, asked: 0 };
  const spawn: Spawn = async (id, options) => {
    if (id === "claude" && options?.args?.join(" ") === "auth status --json") {
      status.asked++;
      // As every Claude starts, and never with the key.
      expect(options).toMatchObject({ env: ENV });
      expect(options).not.toHaveProperty("secrets");
      options.onStdout?.(JSON.stringify(status.own));
      return {
        write: async () => undefined,
        // As native code does once the process exited, as a status soon is.
        end: async () => {
          throw new Error("No such process");
        },
        kill: async () => undefined,
        // As Claude does, signed out exits 1, having said so.
        exited: Promise.resolve(status.own.loggedIn ? 0 : 1),
      };
    }
    started.push({ id, options });
    if (id === "review")
      queueMicrotask(() => options?.onStdout?.("/Users/me/review\n"));
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(0),
    };
  };
  return { spawn, started, status };
}

it("asks native code to start every claude, the protected release included, with the key", async () => {
  const { spawn, started } = host();
  const auth = new ClaudeAuth(spawn);
  const authorized = auth.authorize(spawn, true);
  for (const id of ["claude", "claude-protected-arm64"])
    await authorized(id, { args: ["--verbose"], env: { ...ENV, A: "1" } });
  await authorized("platform", { env: { ...ENV } });
  expect(started.map(({ id }) => id)).toEqual([
    "claude",
    "claude-protected-arm64",
    "platform",
  ]);
  for (const { options } of started.slice(0, 2)) {
    expect(options).toEqual({
      args: ["--verbose"],
      env: { ...ENV, A: "1" },
      secrets: ["anthropic-api-key"],
    });
    // Process launches never read or forward the key through JavaScript.
    expect(JSON.stringify(options)).not.toContain("sk-ant-");
  }
  expect(started[2]?.options).toEqual({ env: { ...ENV } });
});

it("refuses a turn's claude without a key, but lets setup run its checks", async () => {
  const { spawn, started, status } = host();
  store(false);
  const auth = new ClaudeAuth(spawn);
  await expect(
    auth.authorize(spawn, true)("claude", { env: ENV }),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
  // Only the look for a setup it could use instead, which finds none.
  expect(started).toEqual([]);
  expect(status.asked).toBe(1);
  await auth.authorize(spawn)("claude", { args: ["--version"], env: ENV });
  expect(started.at(-1)).toEqual({
    id: "claude",
    options: {
      args: ["--version"],
      env: ENV,
      secrets: ["anthropic-api-key"],
    },
  });
});

it("asks again until a key is saved, then once until it is saved or checked", async () => {
  const { spawn } = host();
  store(false);
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toBeUndefined();
  // No key is not kept: another Buzz on this computer may save one.
  state.saved = true;
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(2);
  // A key is kept until it is checked or saved.
  state.saved = false;
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(2);
  await expect(auth.check()).resolves.toBeUndefined();
  state.saved = true;
  await expect(auth.check()).resolves.toEqual({});
  await auth.save(KEY);
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(5);
});

it("saves the key with native code alone and tells listeners, but not of a refused one", async () => {
  const { spawn, started } = host();
  store(false);
  state.refusals.push("That is not an Anthropic API key.");
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  await expect(auth.save("nope")).rejects.toBe(
    "That is not an Anthropic API key.",
  );
  expect(told).not.toHaveBeenCalled();
  await expect(auth.save(KEY)).resolves.toBe("Saved the Anthropic API key.");
  expect(told).toHaveBeenCalledTimes(1);
  expect(state.saves).toEqual([KEY]);
  expect(started).toEqual([]);
  // A save stopped before it reaches the store saves nothing.
  const stopped = new AbortController();
  stopped.abort();
  await expect(auth.save(KEY, stopped.signal)).rejects.toThrow();
  expect(state.saves).toEqual([KEY]);
});

it("gives a review its own folder, the key coming from native code", async () => {
  const { spawn } = host();
  await expect(new ClaudeAuth(spawn).review()).resolves.toEqual({
    home: "/Users/me/review",
    env: {},
  });
  store(false);
  await expect(new ClaudeAuth(spawn).review()).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
});

it("clears the native key, invalidates cached authorization, and notifies sessions", async () => {
  const { spawn, started } = host();
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  await auth.authorize(spawn, true)("claude");
  await auth.clear();
  expect(state.clears).toBe(1);
  expect(told).toHaveBeenCalledOnce();
  await expect(auth.authorize(spawn, true)("claude")).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
  await expect(auth.review()).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
  // Besides looking for a Claude account, nothing started without the key.
  const turns = () =>
    started.filter(({ options }) => options?.args?.[1] !== "status");
  expect(turns()).toHaveLength(1);
  await auth.save(KEY);
  await auth.authorize(spawn, true)("claude");
  expect(turns()).toHaveLength(2);
});

it("preserves authorization on a failed removal and notifies only after retry succeeds", async () => {
  const { spawn } = host();
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  state.refusals.push("Keychain access was denied.");
  await expect(auth.clear()).rejects.toBe("Keychain access was denied.");
  expect(told).not.toHaveBeenCalled();
  await expect(auth.check()).resolves.toEqual({});
  await auth.clear();
  expect(told).toHaveBeenCalledOnce();
  await expect(auth.check()).resolves.toBeUndefined();
});

it("links a turn that failed for want of a working key to Settings", async () => {
  const auth = new ClaudeAuth(undefined);
  const settings = "buzz://settings?section=agents";
  const missing = await auth
    .authorize(async () => {
      throw new Error("unreachable");
    }, true)("claude")
    .then(
      () => "",
      (error: unknown) => String(error),
    );
  expect(auth.explainTurn(missing, settings)).toBe(
    `Claude is missing an API key. Head to [Settings](${settings}) to add one.`,
  );
  expect(
    auth.explainTurn("Invalid API key · Fix external API key", settings),
  ).toBe(
    `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.`,
  );
  expect(auth.explainTurn("Error: overloaded", settings)).toBe(
    "Error: overloaded",
  );
});

it("points a refusal at both the saved key and the own setup while protected launches use the key", async () => {
  const { spawn } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  await auth.check();
  // A protected launch selects the saved key beside the own setup.
  await auth.authorize(spawn, true)("claude-protected-arm64", {
    env: ENV,
    args: ["--setting-sources", ""],
  });
  const settings = "buzz://settings?section=agents";
  for (const error of [
    "Invalid API key",
    "Invalid API key · Please run /login",
  ])
    expect(auth.explainTurn(error, settings)).toBe(
      `Claude could not authenticate. Protected agents use the API key in [Settings](${settings}): replace it there if it was revoked or ran out of credit. Other agents use your own Claude setup: fix it with the Claude CLI. Then try again.`,
    );
  // Once the key is removed, only the own setup is left to fix.
  await auth.clear();
  await auth.check();
  expect(auth.explainTurn("Invalid API key", settings)).toBe(
    "Claude could not authenticate with your own Claude setup. Fix it with the Claude CLI, then try again.",
  );
});

const SIGNED_IN = {
  loggedIn: true,
  authMethod: "third_party",
  apiProvider: "vertex",
};

it("runs turns with the person's own Claude setup, without the key, even with one saved", async () => {
  const { spawn, started } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  // Ready, without naming the setup.
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.usesOwnSetup).toBe(true);
  const authorized = auth.authorize(spawn, true);
  for (const id of ["claude", "claude-protected-arm64"])
    await authorized(id, { env: ENV });
  expect(started).toEqual([
    { id: "claude", options: { env: ENV } },
    { id: "claude-protected-arm64", options: { env: ENV } },
  ]);
});

it("needs no key while the person's own setup works", async () => {
  store(false);
  const { spawn, started } = host({
    loggedIn: true,
    authMethod: "third_party",
    apiProvider: "bedrock",
  });
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toEqual({});
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started).toEqual([{ id: "claude", options: { env: ENV } }]);
  expect(state.asked).toBe(0);
});

it("still gives security reviews the key, in their own folder", async () => {
  const { spawn, started } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  await auth.check();
  const review = await auth.review();
  const env = { ...ENV, CLAUDE_CONFIG_DIR: review.home };
  await auth.authorize(spawn)("claude-protected-arm64", { env });
  expect(started.at(-1)).toEqual({
    id: "claude-protected-arm64",
    options: { env, secrets: ["anthropic-api-key"] },
  });
});

it("keeps the saved key for protected launches, which read no settings files", async () => {
  const { spawn, started } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  await auth.check();
  const args = ["--verbose", "--setting-sources", ""];
  await auth.authorize(spawn, true)("claude-protected-arm64", {
    env: ENV,
    args,
  });
  expect(started.at(-1)).toEqual({
    id: "claude-protected-arm64",
    options: { env: ENV, args, secrets: ["anthropic-api-key"] },
  });
  // With no key saved, the person's own setup is all a protected launch has.
  store(false);
  const keyless = new ClaudeAuth(spawn);
  await keyless.check();
  await keyless.authorize(spawn, true)("claude-protected-arm64", {
    env: ENV,
    args,
  });
  expect(started.at(-1)).toEqual({
    id: "claude-protected-arm64",
    options: { env: ENV, args },
  });
});

it("asks for the person's own setup once until checked, and tells listeners when it changes", async () => {
  const { spawn, status } = host();
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  const authorized = auth.authorize(spawn, true);
  await authorized("claude");
  await authorized("claude");
  // The version needs no credentials.
  await authorized("claude", { args: ["--version"] });
  expect(status.asked).toBe(1);
  await auth.check();
  expect(told).not.toHaveBeenCalled();
  status.own = SIGNED_IN;
  // Ready, without naming the setup.
  await expect(auth.check()).resolves.toEqual({});
  expect(told).toHaveBeenCalledOnce();
  status.own = { loggedIn: false };
  await expect(auth.check()).resolves.toEqual({});
  expect(told).toHaveBeenCalledTimes(2);
});

it("uses the key when Claude cannot say whether the person has a setup", async () => {
  const started: string[] = [];
  const spawn: Spawn = async (id, options) => {
    started.push([id, ...(options?.args ?? [])].join(" "));
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      // Not installed yet: no JSON.
      exited: Promise.resolve(127),
    };
  };
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.usesOwnSetup).toBe(false);
  await auth.authorize(spawn, true)("claude");
  // An answer Claude could not give is asked again.
  expect(started).toEqual([
    "claude auth status --json",
    "claude auth status --json",
    "claude",
  ]);
});

it("points a refused own setup at the Claude CLI rather than a key", async () => {
  store(false);
  const { spawn } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  await auth.check();
  const settings = "buzz://settings?section=agents";
  for (const error of [
    "Invalid API key · Please run /login",
    "OAuth token has expired. Please run /login",
  ])
    expect(auth.explainTurn(error, settings)).toBe(
      "Claude could not authenticate with your own Claude setup. Fix it with the Claude CLI, then try again.",
    );
  expect(auth.explainTurn("Error: overloaded", settings)).toBe(
    "Error: overloaded",
  );
});
/** Agent storage holding only what it is given. `stale` keeps this
 * program's copy from ever seeing it, as another program's writes. */
function storage(
  values = new Map<string, string>(),
  stale = false,
): AgentStore {
  return {
    keys: () => [...values.keys()],
    get: (key) => (stale ? null : (values.get(key) ?? null)),
    read: async (key) => values.get(key) ?? null,
    scan: async () => Object.fromEntries(values),
    set: async (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
    add: async (key, value) => values.get(key) ?? value,
  };
}

it("runs Claude on the account it signed in to when no key is saved, as before keys", async () => {
  const { spawn, started } = host({ loggedIn: true, email: "me@example.org" });
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await expect(auth.check()).resolves.toEqual({ account: "me@example.org" });
  expect(auth.found.method).toBe("account");
  expect(auth.needs).toBe("is not signed in to a Claude account");
  // No key is asked for, and none is required.
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)).toEqual({ id: "claude", options: { env: ENV } });
  // A review's own Claude folder can't reach the account: it needs the key.
  await expect(auth.review()).rejects.toThrow(
    "Claude security reviews need an Anthropic API key, even when Claude runs with your Claude account.",
  );
  store(true);
  await auth.use("account");
  await auth.authorize(spawn)("claude-protected-arm64", {
    env: { ...ENV, CLAUDE_CONFIG_DIR: "/Users/me/review" },
  });
  expect(started.at(-1)?.options?.secrets).toEqual(["anthropic-api-key"]);
});

it("uses the own setup until the owner picks the key, even over a saved one, and the account again on request", async () => {
  const { spawn, started } = host({ loggedIn: true });
  const auth = new ClaudeAuth(spawn, storage());
  const told = vi.fn();
  auth.subscribe(told);
  // Until the owner chooses, the setup that works leads, a saved key or not.
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.found).toMatchObject({ method: "account" });
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)?.options?.secrets).toBeUndefined();
  // The owner's choice of the key beats it.
  await auth.use("api-key");
  expect(told).toHaveBeenCalledTimes(1);
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.found).toMatchObject({ method: "api-key", key: true });
  expect(auth.usesOwnSetup).toBe(false);
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)?.options?.secrets).toEqual(["anthropic-api-key"]);
  await auth.use("account");
  expect(told).toHaveBeenCalledTimes(2);
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.found).toMatchObject({ method: "account", key: true });
  expect(auth.usesOwnSetup).toBe(true);
  // A key saved is the one to use.
  await auth.save(KEY);
  expect(told).toHaveBeenCalledTimes(3);
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.found.method).toBe("api-key");
});

it("signs in as setup's step, then uses the account, but not once cancelled", async () => {
  const { spawn } = host();
  const auth = new ClaudeAuth(spawn, storage());
  const step = vi.fn(async () => undefined);
  await auth.signIn?.(step);
  expect(step.mock.calls).toEqual([["claude", ["auth", "login"], "Sign-in"]]);
  await auth.check();
  expect(auth.found.method).toBe("account");
  // Claude Code already signed in, as from a terminal: no browser sign-in.
  const signedIn = host({ loggedIn: true, email: "me@example.org" });
  const reused = new ClaudeAuth(signedIn.spawn, storage());
  const unused = vi.fn(async () => undefined);
  await reused.signIn?.(unused);
  expect(unused).not.toHaveBeenCalled();
  await expect(reused.check()).resolves.toEqual({ account: "me@example.org" });
  // A cancelled step throws, as setup's does, and the choice stays.
  const other = new ClaudeAuth(spawn, storage());
  await expect(
    other.signIn?.(async () => {
      throw new Error("Sign-in ended (stopped).");
    }),
  ).rejects.toThrow("stopped");
  await other.check();
  expect(other.found.method).toBe("api-key");
});

it("asks for a key, not a sign-in, when Claude has neither", async () => {
  const { spawn } = host();
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await expect(auth.check()).resolves.toBeUndefined();
  expect(auth.found.method).toBe("api-key");
  await expect(
    auth.authorize(spawn, true)("claude", { env: ENV }),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
});

it("links a turn whose account sign-in lapsed to Settings", () => {
  const settings = "buzz://settings?section=agents";
  expect(
    new ClaudeAuth(undefined).explainTurn(
      "Not logged in · Please run /login",
      settings,
    ),
  ).toBe(
    `Claude is not signed in to your Claude account. Head to [Settings](${settings}) to sign in.`,
  );
});

it("looks for the account before a first check, so an early turn isn't refused", async () => {
  const { spawn, started } = host({ loggedIn: true });
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)).toEqual({ id: "claude", options: { env: ENV } });
  expect(auth.found.method).toBe("account");
});

it("takes a credential Claude holds itself, as from a helper, for the person's own setup", async () => {
  const { spawn } = host({ loggedIn: true, authMethod: "api_key_helper" });
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.found).toEqual({
    method: "account",
    key: false,
    account: { label: "" },
  });
});

it("uses another program's choice, saved after this one read its copy", async () => {
  const { spawn, started } = host({ loggedIn: true });
  const saved = new Map<string, string>();
  await new ClaudeAuth(spawn, storage(saved)).use("account");
  const other = new ClaudeAuth(spawn, storage(saved, true));
  await other.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)?.options?.secrets).toBeUndefined();
});

it("checks again when a key is saved while a check is under way", async () => {
  let answer: (() => void) | undefined;
  const { spawn: base } = host({ loggedIn: false });
  // The account's status waits, as a slow `claude` would.
  const spawn: Spawn = async (id, options) => {
    if (options?.args?.[0] === "auth")
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
    return base(id, options);
  };
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  const checking = auth.check();
  await vi.waitFor(() => expect(answer).toBeDefined());
  await auth.save(KEY);
  answer?.();
  await expect(checking).resolves.toEqual({});
  expect(auth.found).toEqual({ method: "api-key", key: true });
});

it("finds an account signed in from a terminal once checked again", async () => {
  const { spawn, started, status } = host({ loggedIn: false });
  store(false);
  const auth = new ClaudeAuth(spawn, storage());
  await expect(auth.check()).resolves.toBeUndefined();
  status.own = { loggedIn: true };
  await expect(auth.check()).resolves.toEqual({});
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started.at(-1)).toEqual({ id: "claude", options: { env: ENV } });
});

it("runs on the chosen account when secure storage can't be read, but not on the key", async () => {
  const { spawn, status } = host({ loggedIn: false });
  store(false);
  state.unreadable = true;
  const values = new Map<string, string>();
  const auth = new ClaudeAuth(spawn, storage(values));
  await expect(auth.check()).rejects.toThrow();
  status.own = { loggedIn: true, email: "me@example.org" };
  await auth.use("account");
  await expect(auth.check()).resolves.toEqual({ account: "me@example.org" });
});

it("names the account's organization only when it isn't the personal one", async () => {
  store(false);
  const team = host({
    loggedIn: true,
    email: "me@example.org",
    orgName: "Acme",
  });
  await expect(new ClaudeAuth(team.spawn, storage()).check()).resolves.toEqual({
    account: "me@example.org · Acme",
  });
  const personal = host({
    loggedIn: true,
    email: "me@example.org",
    orgName: "me@example.org's Organization",
  });
  await expect(
    new ClaudeAuth(personal.spawn, storage()).check(),
  ).resolves.toEqual({ account: "me@example.org" });
});

it("offers the saved key once the account's sign-in lapses", async () => {
  const account = { loggedIn: true };
  const { spawn } = host(account);
  const auth = new ClaudeAuth(spawn, storage());
  await auth.use("account");
  account.loggedIn = false;
  await expect(auth.check()).resolves.toBeUndefined();
  expect(auth.found).toEqual({ method: "account", key: true });
});
