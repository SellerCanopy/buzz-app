// How Buzz's Claude authenticates. With the person's own Claude setup when
// it already works (a Claude account signed in with `claude auth login`, or
// Amazon Bedrock, Google Vertex AI and the like, as `claude auth status`
// finds it); otherwise as the owner chooses: with an Anthropic API key,
// pasted in setup and kept by native code in the OS credential store
// (`claude_key.rs`), which gives it to `claude` as `ANTHROPIC_API_KEY`, never
// as an argument, and never back to the app; or with the Claude account (a
// subscription) that `claude auth login` signs in to, which Claude keeps
// itself. An explicit choice beats the own setup found; the key beats nothing
// until the owner saves one.
//
// Builds can replace this one file with another way to sign in, so the rest
// of the plugin reaches authentication only through its exports: keep their
// names and shapes when changing it. The optional ClaudeAuth.Settings surface
// belongs to this authentication method; other implementations may omit it.
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ClaudeSettings, type ClaudeConnection } from "./ClaudeSettings";
import { ApiKeyForm } from "../../features/settings/ApiKeyForm";
import { Button } from "../../shared/design-system/ui/Button";
import inlineStyles from "../../shared/InlineReference.module.css";
import type { AgentStore } from "../../features/agents/store";
import { ENV, type Spawn } from "./claude";
import type { ClaudeSetup } from "./setup";

const NO_KEY =
  "Claude needs an Anthropic API key. Add one in Settings → Claude.";
const NO_REVIEW_KEY =
  "Claude security reviews need an Anthropic API key, even when Claude runs with your Claude account. Add one in Settings → Claude.";
/** What setup says while Claude has no working setup: either way works. */
export const CONNECT =
  "Buzz can help you configure your Claude setup with an API key, or use the Claude CLI to configure your own connection and refresh Buzz.";
/** What setup says first: the key is one for all of Claude, not per agent. */
export const KEY_ONCE = `${CONNECT} Create a key at console.anthropic.com and paste it below.`;
/** The same where setup can also sign in to a Claude account (`signIn`). */
const KEY_ONCE_ACCOUNT =
  "Sign in with your Claude account (Pro, Max, Team or Enterprise), or create an API key at console.anthropic.com and paste it below. You only have to set this up once.";
const REJECTED_KEY =
  "Anthropic rejected the Claude API key. It may have been revoked or run out of credit. Paste a working key in Settings → Claude.";

/** Runs one process as a setup step, its output shown; throws unless it
 * succeeds. */
export type Step = (
  id: string,
  args: readonly string[],
  label: string,
) => Promise<void>;
type Env = Readonly<Record<string, string | null>>;
/** The two ways Claude can authenticate. */
export type Method = "api-key" | "account";
/** The owner's choice, in agent storage, which every program running this
 * computer's agents shares. */
const METHOD_KEY = "buzz.claude-code.auth-method.v1";
const isMethod = (value: unknown): value is Method =>
  value === "api-key" || value === "account";

/** Runs a `claude.sh` step; its output, or throws what it printed. */
async function output(spawn: Spawn, id: string) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    onStdout: (text) => {
      stdout += text;
    },
    onStderr: (text) => {
      stderr += text;
    },
  });
  await process.end();
  const code = await process.exited;
  if (code !== 0)
    throw new Error(stderr.trim() || `${id} ended (${code ?? "stopped"}).`);
  return stdout;
}

/** How long `claude auth status` may take; it reads only local settings. */
const STATUS_TIMEOUT_MS = 15_000;
/** The person's own setup, as far as Claude says who it is for: the account's
 * label, empty when it has none to show (a cloud provider's setup has no
 * email). */
type Connection = Readonly<{ label: string }>;

/** The person's own Claude setup, which works without Buzz's key: what
 * `claude auth status` finds in `~/.claude`, its settings and the app's
 * environment, asked as every Claude starts (`ENV`) and without the key:
 * found, or undefined when it is signed out; throws when Claude cannot say,
 * such as before Buzz's copy is installed. Which setup it is stays Claude's
 * own, so only an account's email and organization are shown. It reads only
 * local settings, so revoked credentials still count until a turn fails. */
async function ownConnection(spawn: Spawn): Promise<Connection | undefined> {
  let stdout = "";
  const process = await spawn("claude", {
    args: ["auth", "status", "--json"],
    env: ENV,
    onStdout: (text) => {
      stdout += text;
    },
  });
  const timer = setTimeout(() => void process.kill(), STATUS_TIMEOUT_MS);
  try {
    // Not `end()`: it rejects once the process has already exited, as a
    // status soon has.
    await process.exited;
  } finally {
    clearTimeout(timer);
  }
  // Signed out exits 1, still with its JSON.
  const status = JSON.parse(stdout) as {
    loggedIn?: unknown;
    email?: string;
    orgName?: string;
  } | null;
  if (!status || typeof status !== "object")
    throw new Error("Claude did not report its setup");
  if (status.loggedIn !== true) return undefined;
  // A personal account's organization is "<email>'s Organization".
  const personal = status.email && status.orgName?.includes(status.email);
  return {
    label: [status.email, !personal && status.orgName]
      .filter(Boolean)
      .join(" · "),
  };
}

/** The native store never returns saved credentials to setup or Settings.
 * Native code injects the key into the Claude processes that request it. */
const nativeStore = ():
  | Readonly<{
      /** Whether a key is saved. */
      status(): Promise<boolean>;
      /** Saves the key without echoing it. */
      save(key: string): Promise<void>;
      clear(): Promise<void>;
    }>
  | undefined =>
  isTauri()
    ? {
        status: async () => (await invoke("claude_api_key_status")) === true,
        save: (value) => invoke("claude_api_key_set", { value }),
        clear: () => invoke("claude_api_key_clear"),
      }
    : undefined;

/** Whether Claude leads the Harness list and is new agents' default
 * (`src/bundled/index.ts`). Not here: Claude asks for an API key before its
 * first agent, so Codex leads. A build whose Claude signs in without that
 * friction can put it first. */
export const leadsHarnesses = false;

/** Claude's credentials on this computer. */
export class ClaudeAuth {
  /** Which ways this build authenticates. */
  readonly id = "buzz-claude-auth:api-key+account";
  private saved: Promise<boolean> | undefined;
  /** The person's own setup, asked once until checked again. */
  private own: Promise<Connection | undefined> | undefined;
  /** Whether the last answer found the person's own setup; undefined until
   * one has. */
  private owned: boolean | undefined;
  /** The last own setup found, and whether a key was saved, as last asked. */
  private account: Connection | undefined;
  private key = false;
  /** The owner's choice as last read, or made without agent storage. */
  private choice: Method | undefined;
  /** Counts choices made, so a check under way when one is made looks again. */
  private changes = 0;
  private readonly listeners = new Set<() => void>();

  private readonly store;

  constructor(
    private readonly spawn: Spawn | undefined,
    private readonly storage?: AgentStore,
  ) {
    this.store = spawn ? nativeStore() : undefined;
  }

  /** What the last check found: the way in use, whether a key is saved, and
   * the Claude account or own setup Claude is signed in to, when it asked. */
  get found(): Readonly<{
    method: Method;
    key: boolean;
    account?: Readonly<{ label: string }>;
  }> {
    return {
      method: this.choice ?? (this.account ? "account" : "api-key"),
      key: this.key,
      ...(this.account && { account: this.account }),
    };
  }

  /** Optional management UI for this build's authentication method. */
  get Settings():
    | ComponentType<{
        setup: ClaudeSetup;
        active(): boolean;
        connection?: ClaudeConnection | undefined;
      }>
    | undefined {
    return ({ setup, active, connection }) => (
      <ClaudeSettings
        setup={setup}
        active={active}
        read={this.credentials}
        connect={CONNECT}
        clearKey={() => this.clear()}
        connection={connection}
      />
    );
  }

  /** What the agent type's row asks for while Claude cannot run. It names
   * the "Sign in" or "Add key" button beside Harness, so it follows `signIn`. */
  get attentionLabel() {
    return this.signIn ? "Sign in to Claude" : "Add Claude API key";
  }
  /** Ends "Claude 2.1.0 …" while Claude cannot run. */
  get needs() {
    return this.found.method === "account"
      ? "is not signed in to a Claude account"
      : "needs an Anthropic API key";
  }

  /** Uses the Claude account from then on, signing in first, as setup's
   * step, which setup can cancel, only when Claude Code isn't already. */
  readonly signIn: ((step: Step) => Promise<void>) | undefined = async (
    step,
  ) => {
    // Asked afresh: a sign-in made or lapsed since the last answer counts.
    this.own = undefined;
    if (!(await this.connection()))
      await step("claude", ["auth", "login"], "Sign-in");
    await this.use("account");
  };

  /** Uses `method` for every `claude` started from now on. */
  async use(method: Method) {
    if (this.storage) await this.storage.set(METHOD_KEY, method);
    this.choice = method;
    this.own = undefined;
    this.changes++;
    for (const listener of this.listeners) listener();
  }

  /** The way the owner chose, if they have, as saved: another program on
   * this computer may have chosen since this one read it. */
  private async chosen() {
    if (this.storage) {
      const chosen = await this.storage.read(METHOD_KEY);
      this.choice = isMethod(chosen) ? chosen : undefined;
    }
    return this.choice;
  }

  /** Whether `args` start a Claude that runs as the person's account or own
   * setup rather than with the key. A choice made decides; until one is,
   * the own setup does. A protected launch reads no settings files, where a
   * setup can live (provider variables, `apiKeyHelper`), and `auth status`
   * cannot be asked that way: it keeps the key when one is saved. */
  private async runsOnOwnSetup(args: readonly string[]) {
    const chosen = await this.chosen();
    if (chosen) return chosen === "account";
    if (args.includes("--setting-sources") && (await this.has())) return false;
    return !!(await this.connection());
  }

  /** Told when the credentials change, so running sessions start again. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whether a key is saved, asked once until it is saved again or checked;
   * no key is asked again each time. A saved key is still what protected
   * launches use beside the person's own setup. */
  private has() {
    const store = this.store;
    if (!store) return Promise.resolve(false);
    if (this.saved) return this.saved;
    const asking = store.status();
    this.saved = asking;
    // Only a saved key is kept: another Buzz on this computer may save one.
    const forget = () => {
      if (this.saved === asking) this.saved = undefined;
    };
    asking.then((saved) => {
      this.key = saved;
      if (!saved) forget();
    }, forget);
    return asking;
  }

  /** The person's own setup, asked once until it is checked again. An
   * answer Claude could not give is not kept. A change of answer is a change
   * of credentials, so listeners are told. */
  private connection() {
    const spawn = this.spawn;
    if (!spawn) return Promise.resolve(undefined);
    if (this.own) return this.own;
    const asking = ownConnection(spawn).then(
      (own) => {
        if (this.own === asking) {
          const changed = this.owned !== undefined && this.owned !== !!own;
          this.owned = !!own;
          this.account = own;
          if (changed) for (const listener of this.listeners) listener();
        }
        return own;
      },
      () => {
        if (this.own === asking) this.own = undefined;
        return undefined;
      },
    );
    this.own = asking;
    return asking;
  }

  /** Whether Claude runs with the person's own setup or account rather than
   * the key, as last checked. */
  get usesOwnSetup() {
    return this.found.method === "account" && this.account !== undefined;
  }

  /** Whether Claude can run turns the chosen way: an account to show, or
   * undefined. Until the owner chooses, the person's own setup comes first,
   * so a saved key never overrides it. */
  async check(): Promise<Readonly<{ account?: string }> | undefined> {
    for (;;) {
      const changes = this.changes;
      const chosen = await this.chosen();
      // Each check asks again, not a read another check started.
      this.saved = undefined;
      this.own = undefined;
      // The key is all that runs once chosen, so the own setup isn't asked.
      const own = chosen === "api-key" ? undefined : await this.connection();
      const method = chosen ?? (own ? "account" : "api-key");
      // The key store is asked when the key could be used, or the owner
      // chose: the own setup alone needs nothing from it. The account
      // doesn't need it either, so a refused one can't stop it.
      const key =
        chosen === undefined && own
          ? this.key
          : await this.has().catch((error: unknown) => {
              if (method === "account") return false;
              throw error;
            });
      // A choice made meanwhile, such as a key saved, outdates all this.
      if (changes !== this.changes) continue;
      this.key = key;
      if (method === "api-key") return key ? {} : undefined;
      if (!own) return undefined;
      return own.label ? { account: own.label } : {};
    }
  }

  /** What Settings needs, asked again: whether the person has a setup of
   * their own, and whether a key is saved, which security reviews still
   * need. */
  private readonly credentials = async () => {
    this.saved = undefined;
    this.own = undefined;
    const [own, key] = await Promise.all([
      this.connection(),
      this.has(),
      this.chosen(),
    ]);
    return { own: !!own, key };
  };

  /** Saves `key` for every `claude` started from now on; what to say. A
   * save can't be stopped once it reaches the store, so `signal` only
   * stops one that hasn't. */
  async save(key: string, signal?: AbortSignal) {
    const store = this.store;
    if (!store) throw new Error("Claude runs only in the desktop app");
    signal?.throwIfAborted();
    try {
      await store.save(key);
      this.key = true;
    } finally {
      // A refused save leaves the key as it was; anything else may not.
      this.saved = undefined;
    }
    // A key saved is the one to use.
    await this.use("api-key");
    return "Saved the Anthropic API key.";
  }

  /** Removes the saved key and retires sessions using it through the same
   * credential-change notification as replacement. */
  async clear() {
    const store = this.store;
    if (!store) throw new Error("Claude runs only in the desktop app");
    try {
      await store.clear();
      this.key = false;
    } finally {
      this.saved = undefined;
    }
    for (const listener of this.listeners) listener();
  }

  /** `spawn`, starting each `claude` the way it is set up: as the person's
   * own setup or account, which works without Buzz's key, or with the saved
   * key, which native code sets itself. One with its own Claude folder (a
   * review's) can't reach that account, so it always gets the key.
   * `required` refuses to start one meant to use a key without one, so no
   * such turn falls back on an account sign-in that `~/.claude` may hold. */
  authorize(spawn: Spawn, required = false): Spawn {
    return async (id, options) => {
      // Buzz's copy, and the protected release (`claude-protected-*`).
      if (id !== "claude" && !id.startsWith("claude-protected-"))
        return spawn(id, options);
      const args = options?.args ?? [];
      // The version needs no credentials.
      if (
        args[0] !== "--version" &&
        !options?.env?.CLAUDE_CONFIG_DIR &&
        (await this.runsOnOwnSetup(args))
      )
        return spawn(id, options);
      if (required && !(await this.has())) throw new Error(NO_KEY);
      return spawn(id, {
        ...options,
        secrets: [...(options?.secrets ?? []), "anthropic-api-key"],
      });
    };
  }

  /** Security reviews' own Claude folder (absolute), which contained agents
   * cannot write, and what they authenticate with: the key, which
   * `authorize` asks native code for. */
  async review(): Promise<Readonly<{ home: string; env: Env }>> {
    const spawn = this.spawn;
    if (!spawn) throw new Error("Claude reviews need the desktop app");
    if (!(await this.has()))
      throw new Error(this.found.method === "account" ? NO_REVIEW_KEY : NO_KEY);
    const home = (await output(spawn, "review")).trim();
    if (!home.startsWith("/"))
      throw new Error("Claude's review folder is unreadable");
    return { home, env: {} };
  }

  /** A failed review's error, as the person can act on it. */
  explain(error: string) {
    return rejected(error) ? REJECTED_KEY : error;
  }

  /** A failed turn's error as its report in the conversation says it, in
   * Markdown: a missing or rejected key, or a lapsed sign-in, links to
   * `settings`, where it is fixed once for every Claude agent. */
  explainTurn(error: string, settings: string) {
    // Claude's words don't say which credential failed. Beside the person's
    // own setup, a saved key is still what protected launches use.
    if (this.usesOwnSetup && (rejected(error) || /\/login\b/.test(error)))
      return this.key
        ? `Claude could not authenticate. Protected agents use the API key in [Settings](${settings}): replace it there if it was revoked or ran out of credit. Other agents use your own Claude setup: fix it with the Claude CLI. Then try again.`
        : "Claude could not authenticate with your own Claude setup. Fix it with the Claude CLI, then try again.";
    if (error.includes(NO_KEY))
      return `Claude is missing an API key. Head to [Settings](${settings}) to add one.`;
    if (signedOut(error))
      return `Claude is not signed in to your Claude account. Head to [Settings](${settings}) to sign in.`;
    return rejected(error)
      ? `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.`
      : error;
  }
}

/** Whether a turn's error is Buzz's own refusal to start Claude without a
 * key, rather than anything Claude said. */
export const refusedByBuzz = (error: string) => error.includes(NO_KEY);

/** Whether Claude's error says Anthropic refused the key; turns end with
 * "Invalid API key · Fix external API key". */
const rejected = (error: string) =>
  /authentication_error|invalid x-api-key|invalid api key/i.test(error);
/** Whether Claude's error says the account sign-in is missing or lapsed:
 * "Not logged in · Please run /login", or an expired or revoked token. */
const signedOut = (error: string) =>
  /not logged in|please run \/login|oauth token .*(expired|revoked)/i.test(
    error,
  );

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Switches Claude to the key already saved. */
function UseKey({ setup }: { setup: ClaudeSetup }) {
  return (
    <div>
      <Button
        type="button"
        size="sm"
        disabled={!!setup.snapshot().running}
        onClick={() =>
          void setup.auth.use("api-key").then(
            () => setup.check(),
            () => undefined,
          )
        }
      >
        Use your API key
      </Button>
    </div>
  );
}

/** Setup's ask while Claude cannot run: the key, once for every agent.
 * `onSaved` follows a saved key, so a surface can close. */
export function SignIn({
  setup,
  disabled = false,
  readOnly = false,
  variant = "full",
  onSaved,
  active,
  onSavingChange,
  render,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  readOnly?: boolean;
  variant?: "full" | "compact" | "dialog";
  onSaved?: (() => void) | undefined;
  active?: (() => boolean) | undefined;
  onSavingChange?: ((saving: boolean) => void) | undefined;
  /** Keep the form owner alive while its navigated presentation is hidden. */
  render?: ((form: ReactNode) => ReactNode) | undefined;
}) {
  return (
    <div className="grid gap-3">
      {/* Settings puts the introduction in its shared page header. */}
      {variant !== "dialog" && (
        <p className="m-0 text-body-sm text-secondary">
          {setup.auth.signIn ? KEY_ONCE_ACCOUNT : KEY_ONCE}
        </p>
      )}
      {/* An account's sign-in lapsed: the key saved before still works. */}
      {setup.auth.found.method === "account" && setup.auth.found.key && (
        <UseKey setup={setup} />
      )}
      <KeyForm
        setup={setup}
        disabled={disabled}
        readOnly={readOnly}
        onSaved={onSaved}
        active={active}
        onSavingChange={onSavingChange}
        render={render}
      />
    </div>
  );
}

/** Claude's settings once it can run: the way it signs in, replacing the
 * key, and switching to the other way. `onSaved` follows a saved key, so a
 * surface can close. */
export function SignedIn({
  setup,
  onSaved,
}: {
  setup: ClaudeSetup;
  onSaved?: (() => void) | undefined;
}) {
  const { method, key, account } = setup.auth.found;
  const busy = !!setup.snapshot().running;
  if (method === "api-key")
    return (
      <div className="grid gap-2">
        <p className="m-0 text-body-sm text-subtle">
          Claude runs with your Anthropic API key.
        </p>
        <KeyForm setup={setup} replace onSaved={onSaved} />
        {setup.auth.signIn && (
          <div>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void setup.run("sign-in")}
            >
              Use Claude account
            </Button>
          </div>
        )}
      </div>
    );
  // Claude runs as the person set it up; with no way to sign in here, there
  // is no key to replace.
  if (!setup.auth.signIn) return null;
  return (
    <div className="grid gap-2">
      <p className="m-0 text-body-sm text-subtle">
        Claude runs with your Claude account
        {account?.label ? ` (${account.label})` : ""}.
      </p>
      {key ? (
        <UseKey setup={setup} />
      ) : (
        <KeyForm setup={setup} onSaved={onSaved} />
      )}
    </div>
  );
}

/** Where an agent's own surface, such as its library card, says Claude
 * cannot run: setup is one step in Settings, not one per agent. */
export function Missing({
  openSettings,
}: {
  openSettings?: (() => void) | undefined;
}) {
  return (
    <p className="m-0 text-body-sm text-secondary">
      Claude is not set up.{" "}
      {openSettings ? (
        <>
          Head to{" "}
          <button
            type="button"
            className={inlineStyles.link}
            onClick={openSettings}
          >
            Settings
          </button>{" "}
          to sign in or add an API key.
        </>
      ) : (
        "Sign in or add an API key in Settings → Claude."
      )}
    </p>
  );
}

function KeyForm({
  setup,
  disabled: off = false,
  readOnly = false,
  replace = false,
  onSaved,
  active = () => true,
  onSavingChange,
  render,
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  readOnly?: boolean;
  replace?: boolean;
  onSaved?: (() => void) | undefined;
  active?: (() => boolean) | undefined;
  onSavingChange?: ((saving: boolean) => void) | undefined;
  render?: ((form: ReactNode) => ReactNode) | undefined;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState<AbortController>();
  // Kept until the form closes.
  const [saved, setSaved] = useState<{ ok: boolean; text: string }>();
  // A sign-in under way would choose the account after a key saved now.
  const signingIn =
    useSyncExternalStore(setup.subscribe, setup.snapshot).running === "sign-in";
  const disabled = off || signingIn;
  // Closing the form cancels a save.
  useEffect(() => () => saving?.abort(), [saving]);
  const save = async () => {
    if (!active() || !key.trim() || saving || disabled) return;
    const controller = new AbortController();
    setSaving(controller);
    onSavingChange?.(true);
    setSaved(undefined);
    try {
      const text = await setup.auth.save(key.trim(), controller.signal);
      setKey("");
      setSaved({ ok: true, text });
      await setup.check();
      onSaved?.();
    } catch (error) {
      if (!controller.signal.aborted)
        setSaved({ ok: false, text: message(error) });
    } finally {
      setSaving(undefined);
      onSavingChange?.(false);
    }
  };
  const form = (
    <ApiKeyForm
      label={replace ? "Replace API key" : "Anthropic API key"}
      description={
        replace
          ? "Create a key at console.anthropic.com. Buzz keeps it securely on this computer and gives it only to Claude, so commands your Claude agents run can read it."
          : "Your key will be stored securely on this computer."
      }
      value={key}
      onValueChange={setKey}
      onSave={() => void save()}
      disabled={disabled}
      readOnly={readOnly}
      saving={!!saving}
      variant={replace ? "subtle" : "prominent"}
      feedback={
        saved && (
          <p
            role={saved.ok ? "status" : "alert"}
            className={
              saved.ok ? "m-0 text-body-sm text-subtle" : "buzz-field-error m-0"
            }
          >
            {saved.text}
          </p>
        )
      }
    />
  );
  return render ? render(form) : form;
}
