import { useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { IssueHit } from "./gen/kiln/engine/v1/engine_pb";

/** An issue a person took: the repo as `owner/name` and its number. */
export type PickedIssue = { owner: string; repo: string; number: number };

const STATES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "any", label: "Any" },
] as const;

type Search = {
  repo: string;
  text: string;
  label: string;
  state: string;
  assignee: string;
  n: number;
};

type Repos =
  | { status: "loading" }
  | { status: "ready"; repos: string[]; truncated: boolean }
  | { status: "error"; message: string };

type Found =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; issues: IssueHit[]; truncated: boolean }
  | { status: "error"; message: string };

/**
 * Finds issues to take as cards: a repo from those the team's token reaches, then the text,
 * label, state and assignee that narrow it. The issues are read when the repo changes and when
 * Search is pressed, not on each key. Titles and labels come from outside Beehive and are shown
 * as plain text.
 */
export function IssuePicker({
  client,
  disabled,
  onTake,
}: {
  client: Client;
  disabled: boolean;
  /** Makes a card of the issue. The picker waits while `disabled`. */
  onTake(issue: PickedIssue): void;
}) {
  const [repos, setRepos] = useState<Repos>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [state, setState] = useState("open");
  const [assignee, setAssignee] = useState("");
  const [found, setFound] = useState<Found>({ status: "idle" });

  useEffect(() => {
    // `attempt` reads the repos again after a failure.
    void attempt;
    const abort = new AbortController();
    setRepos({ status: "loading" });
    client
      .listRepos(abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        setRepos({
          status: "ready",
          repos: reply.repos,
          truncated: reply.truncated,
        });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setRepos({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, attempt]);

  // What the last search asked for. It changes when the repo does and when Search is pressed,
  // so typing does not read the host; a newer search replaces an older one.
  const [query, setQuery] = useState<Search>();
  useEffect(() => {
    if (!query) return;
    const abort = new AbortController();
    setFound({ status: "loading" });
    client
      .searchIssues(
        {
          repos: [query.repo],
          text: query.text,
          label: query.label.trim(),
          assignee: query.assignee.trim(),
          state:
            query.state === "any" ? "" : (query.state as "open" | "closed"),
        },
        abort.signal,
      )
      .then((reply) => {
        if (abort.signal.aborted) return;
        setFound({
          status: "ready",
          issues: reply.issues,
          truncated: reply.truncated || reply.nextCursor !== "",
        });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setFound({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, query]);
  const search = (nextRepo = repo) =>
    setQuery((last) => ({
      repo: nextRepo,
      text,
      label,
      state,
      assignee,
      n: (last?.n ?? 0) + 1,
    }));

  const choose = (next: string) => {
    setRepo(next);
    search(next);
  };
  // Enter in a field searches; it does not take anything.
  const searchOnEnter = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    search();
  };

  return (
    <>
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
        {repos.status === "ready" && (
          <Select
            label="Repo"
            variant="field"
            placeholder="Choose a repo"
            value={repo}
            disabled={disabled}
            description={
              repos.truncated
                ? "The list is partial. A repo that is missing may still exist."
                : undefined
            }
            onValueChange={choose}
            groups={[
              {
                label: "Repos",
                options: repos.repos.map((name) => ({
                  value: name,
                  label: name,
                })),
              },
            ]}
          />
        )}
      </LoadingRegion>
      {repo && (
        <>
          <Field label="Text" optional>
            <Input
              value={text}
              disabled={disabled}
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={searchOnEnter}
            />
          </Field>
          <Field label="Label" optional>
            <Input
              value={label}
              disabled={disabled}
              autoComplete="off"
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={searchOnEnter}
            />
          </Field>
          <Select
            label="State"
            variant="field"
            value={state}
            disabled={disabled}
            onValueChange={setState}
            groups={[{ label: "State", options: [...STATES] }]}
          />
          <Field
            label="Assignee"
            optional
            description="A login, or none for issues nobody has. Leave empty for any."
          >
            <Input
              value={assignee}
              disabled={disabled}
              autoComplete="off"
              onChange={(event) => setAssignee(event.target.value)}
              onKeyDown={searchOnEnter}
            />
          </Field>
          <div>
            <Button disabled={disabled} onClick={() => search()}>
              Search
            </Button>
          </div>
          <LoadingRegion
            pending={found.status === "loading"}
            label="Searching issues…"
            feedback={
              found.status === "error" ? (
                <p role="alert" className="text-danger">
                  {found.message}
                </p>
              ) : undefined
            }
          >
            {found.status === "ready" && found.issues.length === 0 && (
              <p className="text-subtle">No issues match.</p>
            )}
            {found.status === "ready" && found.issues.length > 0 && (
              <ul className="beehive-cards" aria-label="Issues">
                {found.issues.map((issue) => {
                  const ref = issue.ref;
                  if (!ref) return null;
                  return (
                    <li key={`${ref.owner}/${ref.repo}#${ref.number}`}>
                      <PreferenceRow
                        title={issue.title}
                        subtitle={[
                          `${ref.owner}/${ref.repo}#${ref.number}`,
                          ...issue.labels,
                          ...(issue.assignees.length > 0
                            ? [`Assigned to ${issue.assignees.join(", ")}`]
                            : []),
                        ].join(" · ")}
                        trailing={
                          <Button
                            size="sm"
                            disabled={disabled}
                            aria-label={`Take #${ref.number} ${issue.title}`}
                            onClick={() =>
                              onTake({
                                owner: ref.owner,
                                repo: ref.repo,
                                number: ref.number,
                              })
                            }
                          >
                            Take
                          </Button>
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {found.status === "ready" && found.truncated && (
              <p className="text-body-sm text-subtle">
                More issues match. Add text to the search to narrow them.
              </p>
            )}
          </LoadingRegion>
        </>
      )}
    </>
  );
}
