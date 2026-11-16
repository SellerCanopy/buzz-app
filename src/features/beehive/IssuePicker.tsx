import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { Select } from "../../shared/design-system/ui/Select";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { IssueHit } from "./gen/kiln/engine/v1/engine_pb";

/** An issue a person chose: the repo as `owner/name` and its number. */
export type PickedIssue = { owner: string; repo: string; number: number };

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
 * Picks one open issue: a repo from those the team's token reaches, then an issue found by
 * the repo and some text. The list of issues is read when the repo changes and when Search is
 * pressed. Titles and labels come from outside Beehive and are shown as plain text.
 */
export function IssuePicker({
  client,
  disabled,
  picked,
  onPick,
}: {
  client: Client;
  disabled: boolean;
  picked: PickedIssue | undefined;
  onPick(issue: PickedIssue | undefined): void;
}) {
  const [repos, setRepos] = useState<Repos>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
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
  const [query, setQuery] = useState<{
    repo: string;
    text: string;
    n: number;
  }>();
  useEffect(() => {
    if (!query) return;
    const abort = new AbortController();
    setFound({ status: "loading" });
    client
      .searchIssues({ repo: query.repo, text: query.text }, abort.signal)
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
  // A new search replaces the list, so the issue picked from the old one is let go.
  const search = (nextRepo = repo) => {
    onPick(undefined);
    setQuery((last) => ({ repo: nextRepo, text, n: (last?.n ?? 0) + 1 }));
  };

  const choose = (next: string) => {
    setRepo(next);
    search(next);
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
          <Field label="Search" optional>
            <div className="beehive-search">
              <Input
                value={text}
                disabled={disabled}
                autoComplete="off"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // Enter searches; it does not add the card.
                  event.preventDefault();
                  search();
                }}
              />
              <Button disabled={disabled} onClick={() => search()}>
                Search
              </Button>
            </div>
          </Field>
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
              <p className="text-subtle">No open issues match.</p>
            )}
            {found.status === "ready" && found.issues.length > 0 && (
              <Field label="Issue" nativeLabel={false}>
                <RadioGroup
                  value={picked ? `${picked.number}` : ""}
                  disabled={disabled}
                  onValueChange={(value) => {
                    const hit = found.issues.find(
                      (issue) => `${issue.ref?.number}` === value,
                    );
                    if (!hit?.ref) return;
                    onPick({
                      owner: hit.ref.owner,
                      repo: hit.ref.repo,
                      number: hit.ref.number,
                    });
                  }}
                >
                  {found.issues.map((issue) => (
                    <Radio
                      key={issue.ref?.number}
                      value={`${issue.ref?.number}`}
                      label={`#${issue.ref?.number} ${issue.title}`}
                      description={
                        issue.labels.length > 0
                          ? issue.labels.join(", ")
                          : undefined
                      }
                    />
                  ))}
                </RadioGroup>
              </Field>
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
