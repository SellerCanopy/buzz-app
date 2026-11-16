import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { HexagonIcon } from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Select } from "../../shared/design-system/ui/Select";
import { Switch } from "../../shared/design-system/ui/Switch";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { IntakeRule } from "./gen/kiln/engine/v1/engine_pb";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; rules: IntakeRule[] }
  | { status: "error"; message: string };

/**
 * The engine owns the interval rules: a rule that names none reads every 900 seconds, and the
 * least it accepts is 60 (`DEFAULT_INTERVAL_S` and `MIN_INTERVAL_S` in the engine's
 * `domain/intake.rs`). The doc comment on `Intake.interval_s` in the proto says "five minutes"
 * and is out of date; the engine's constants are what a saved rule gets.
 */
export const DEFAULT_INTERVAL_S = 900;
export const MIN_INTERVAL_S = 60;

export const INTERVALS = [
  { seconds: MIN_INTERVAL_S, label: "Every minute" },
  { seconds: 300, label: "Every 5 minutes" },
  { seconds: DEFAULT_INTERVAL_S, label: "Every 15 minutes" },
  { seconds: 1800, label: "Every 30 minutes" },
  { seconds: 3600, label: "Every hour" },
];

/** The seconds a rule really reads at: the engine's default stands in for an unset interval. */
export function effectiveInterval(seconds: number): number {
  return seconds || DEFAULT_INTERVAL_S;
}

/**
 * What `Intake.assignees` takes. These are the values the engine accepts when it saves a rule
 * (an empty value reads as `anyone`); the engine answers with one of the two.
 */
export const ASSIGNEES = {
  anyone: "anyone",
  unassigned: "unassigned",
} as const;

/** How often a rule reads the host, in words. */
export function intervalLabel(seconds: number): string {
  const effective = effectiveInterval(seconds);
  const known = INTERVALS.find((i) => i.seconds === effective);
  return known ? known.label : `Every ${effective} seconds`;
}

/** A rule's search in a line: `owner/repo`, its label and who may have opened the issues. */
export function ruleSummary(rule: IntakeRule): string {
  const intake = rule.intake;
  if (!intake) return "";
  const parts = [intake.repos.join(", ")];
  if (intake.label) parts.push(`label ${intake.label}`);
  if (intake.assignees === ASSIGNEES.unassigned) parts.push("unassigned");
  if (intake.authors.length > 0)
    parts.push(`opened by ${intake.authors.join(", ")}`);
  return parts.filter(Boolean).join(", ");
}

/**
 * The rules that turn the issues of a GitHub repo into cards. Any reader sees them; a person
 * who can run adds, changes, switches off, deletes and refreshes them. Each rule reads one
 * repo on a timer, so Refresh reads it now. The engine refuses a rule it cannot run and its
 * words are shown with the form.
 */
export function IntakePage({
  client,
  canRun,
}: {
  client: Client;
  canRun: boolean;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<IntakeRule | "new">();
  const [deleting, setDeleting] = useState<IntakeRule>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    // `attempt` reads the rules again after a change or a failure.
    void attempt;
    const abort = new AbortController();
    client
      .listIntakeRules(abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        // A read that works clears the failure an earlier read left.
        setFailure(undefined);
        setLoaded({ status: "ready", rules: reply.rules });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const message = errorMessage(error);
        // Rules already on screen stay, with the failure said beside them.
        setFailure(message);
        setLoaded((current) =>
          current.status === "ready" ? current : { status: "error", message },
        );
      });
    return () => abort.abort();
  }, [client, attempt]);

  const run = async (action: () => Promise<string | undefined>) => {
    if (pending) return;
    setPending(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      setNotice(await action());
      reload();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const refresh = (rule?: IntakeRule) =>
    run(async () => {
      const reply = await client.refreshIntake(rule?.id ?? "");
      const added = reply.addedCardIds.length;
      return added === 0
        ? "Nothing new."
        : `Added ${added} ${added === 1 ? "card" : "cards"}.`;
    });
  const toggle = (rule: IntakeRule, enabled: boolean) =>
    run(async () => {
      await client.saveIntakeRule({ ...rule, enabled });
      return undefined;
    });
  const remove = (rule: IntakeRule) =>
    run(async () => {
      await client.deleteIntakeRule(rule.id);
      setDeleting(undefined);
      return undefined;
    });

  const rules = loaded.status === "ready" ? loaded.rules : [];
  return (
    <div className="beehive-intake">
      <InlineHeader
        title="Intake rules"
        subtitle="Open issues of a GitHub repo become cards on the board."
        actions={
          canRun ? (
            <>
              <Button disabled={pending} onClick={() => void refresh()}>
                Refresh all
              </Button>
              <Button
                variant="prominent"
                disabled={pending}
                onClick={() => setEditing("new")}
              >
                New rule
              </Button>
            </>
          ) : undefined
        }
      />
      {notice && (
        <p role="status" className="text-body">
          {notice}
        </p>
      )}
      {failure && !deleting && loaded.status === "ready" && (
        <p role="alert" className="text-danger">
          {failure}
        </p>
      )}
      <LoadingRegion
        pending={loaded.status === "loading"}
        label="Loading rules…"
        feedback={
          loaded.status === "error" ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {loaded.message}
              </p>
              <Button onClick={reload}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {loaded.status === "ready" && rules.length === 0 && (
          <EmptyState
            icon={<HexagonIcon size="1.5rem" />}
            title="No intake rules"
            description="A rule reads one repo on a timer and adds a card for each open issue it takes."
            action={
              canRun ? (
                <Button variant="prominent" onClick={() => setEditing("new")}>
                  New rule
                </Button>
              ) : undefined
            }
          />
        )}
        {rules.length > 0 && (
          <ul className="beehive-rules" aria-label="Intake rules">
            {rules.map((rule) => (
              <li key={rule.id} className="beehive-rule">
                <div className="beehive-rule-text">
                  <span>{rule.name || ruleSummary(rule)}</span>
                  <span className="text-body-sm text-subtle">
                    {[
                      rule.name ? ruleSummary(rule) : "",
                      intervalLabel(rule.intake?.intervalS ?? 0),
                      rule.workflow ? `workflow ${rule.workflow}` : "Backlog",
                      rule.enabled ? "" : "Off",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </div>
                {canRun && (
                  <div className="beehive-rule-actions">
                    <Switch
                      aria-label={`Rule on: ${rule.name || ruleSummary(rule)}`}
                      checked={rule.enabled}
                      disabled={pending}
                      onCheckedChange={(enabled) => void toggle(rule, enabled)}
                    />
                    <Button
                      disabled={pending || !rule.enabled}
                      onClick={() => void refresh(rule)}
                    >
                      Refresh
                    </Button>
                    <Button disabled={pending} onClick={() => setEditing(rule)}>
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={pending}
                      onClick={() => {
                        setFailure(undefined);
                        setDeleting(rule);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </LoadingRegion>
      {editing && (
        <RuleDialog
          client={client}
          rule={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            reload();
          }}
        />
      )}
      {deleting && (
        <AlertDialog
          title="Delete this rule?"
          description="The rule stops reading its repo. Cards it already made stay on the board."
          pending={pending}
          initialFocus={cancelDelete}
          onClose={() => setDeleting(undefined)}
          actions={
            <>
              <Button
                ref={cancelDelete}
                disabled={pending}
                onClick={() => setDeleting(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={pending}
                onClick={() => void remove(deleting)}
              >
                Delete rule
              </Button>
            </>
          }
        >
          {failure && (
            <p role="alert" className="text-body text-danger">
              {failure}
            </p>
          )}
        </AlertDialog>
      )}
    </div>
  );
}

const FORM = "beehive-rule-form";

type Repos =
  | { status: "loading" }
  | { status: "ready"; repos: string[] }
  | { status: "error"; message: string };

/** Logins as typed: separated by commas or spaces, without blanks or a leading `@`. */
export function parseLogins(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((login) => login.replace(/^@/, ""))
    .filter(Boolean);
}

function RuleDialog({
  client,
  rule,
  onClose,
  onSaved,
}: {
  client: Client;
  rule: IntakeRule | undefined;
  onClose(): void;
  onSaved(): void;
}) {
  const intake = rule?.intake;
  const [name, setName] = useState(rule?.name ?? "");
  const [repo, setRepo] = useState(intake?.repos[0] ?? "");
  const [label, setLabel] = useState(intake?.label ?? "");
  const [unassigned, setUnassigned] = useState(
    intake?.assignees === ASSIGNEES.unassigned,
  );
  const [authors, setAuthors] = useState(intake?.authors.join(", ") ?? "");
  const [workflow, setWorkflow] = useState(rule?.workflow ?? "");
  const [interval, setInterval] = useState(
    effectiveInterval(intake?.intervalS ?? 0),
  );
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [repoError, setRepoError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [repos, setRepos] = useState<Repos>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `attempt` reads the repos again after a failure.
    void attempt;
    const abort = new AbortController();
    setRepos({ status: "loading" });
    client
      .listRepos(abort.signal)
      .then((reply) => {
        if (!abort.signal.aborted)
          setRepos({ status: "ready", repos: reply.repos });
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setRepos({ status: "error", message: errorMessage(failure) });
      });
    return () => abort.abort();
  }, [client, attempt]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!repo) {
      setRepoError("Choose a repo.");
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await client.saveIntakeRule({
        id: rule?.id ?? "",
        name: name.trim(),
        enabled,
        workflow: workflow.trim(),
        intake: {
          host: "github.com",
          repos: [repo],
          label: label.trim(),
          assignees: unassigned ? ASSIGNEES.unassigned : ASSIGNEES.anyone,
          authors: parseLogins(authors),
          intervalS: interval,
        },
      });
      onSaved();
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  // The saved repo shows even when the token no longer reaches it.
  const names =
    repos.status === "ready"
      ? repos.repos.includes(repo) || !repo
        ? repos.repos
        : [repo, ...repos.repos]
      : repo
        ? [repo]
        : [];
  const intervals = INTERVALS.some((i) => i.seconds === interval)
    ? INTERVALS
    : [...INTERVALS, { seconds: interval, label: intervalLabel(interval) }];

  return (
    <Dialog
      open
      size="compact"
      title={rule ? "Edit rule" : "New rule"}
      dismissOnOutsideClick={false}
      preventClose={pending}
      onOpenChange={(open) => !open && onClose()}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM}
            variant="prominent"
            loading={pending}
            disabled={pending}
          >
            Save rule
          </Button>
        </>
      }
    >
      <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
        <Field label="Name" optional>
          <Input
            value={name}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <LoadingRegion
          pending={repos.status === "loading"}
          label="Loading repos…"
          feedback={
            repos.status === "error" ? (
              <div className="beehive-error">
                <p role="alert" className="text-danger">
                  {repos.message}
                </p>
                <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
              </div>
            ) : undefined
          }
        >
          <Select
            label="Repo"
            variant="field"
            placeholder="Choose a repo"
            value={repo}
            disabled={pending || repos.status !== "ready"}
            error={repoError}
            onValueChange={(next) => {
              setRepo(next);
              setRepoError(undefined);
            }}
            groups={[
              {
                label: "Repos",
                options: names.map((value) => ({ value, label: value })),
              },
            ]}
          />
        </LoadingRegion>
        <Field
          label="Label"
          optional
          description="Only issues with this label."
        >
          <Input
            value={label}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Select
          label="Assigned to"
          variant="field"
          value={unassigned ? ASSIGNEES.unassigned : ASSIGNEES.anyone}
          disabled={pending}
          onValueChange={(next) => setUnassigned(next === ASSIGNEES.unassigned)}
          groups={[
            {
              label: "Assigned to",
              options: [
                { value: ASSIGNEES.anyone, label: "Anyone or no one" },
                { value: ASSIGNEES.unassigned, label: "No one" },
              ],
            },
          ]}
        />
        <Field
          label="Authors"
          optional
          description="GitHub logins. Only issues they opened are taken, and only their comments reach the card's agent, as text from outside Beehive. With none listed, every author's issues are taken and no comment reaches an agent."
        >
          <Input
            value={authors}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => setAuthors(event.target.value)}
          />
        </Field>
        <Field
          label="Workflow"
          optional
          description="Leave empty to put the cards in Backlog."
        >
          <Input
            value={workflow}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => setWorkflow(event.target.value)}
          />
        </Field>
        <Select
          label="Read the repo"
          variant="field"
          value={`${interval}`}
          disabled={pending}
          onValueChange={(next) => setInterval(Number(next))}
          groups={[
            {
              label: "How often",
              options: intervals.map((i) => ({
                value: `${i.seconds}`,
                label: i.label,
              })),
            },
          ]}
        />
        <Switch
          label="Rule is on"
          checked={enabled}
          disabled={pending}
          onCheckedChange={setEnabled}
        />
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
