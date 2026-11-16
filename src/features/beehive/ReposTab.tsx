import { useState, type FormEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { repoOf } from "./boardModel";
import { pullState } from "./CardDetails";
import { isWebUrl } from "./cardActions";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { Card, PullRequest } from "./gen/kiln/engine/v1/engine_pb";

/** One repo of a card: where it stands and why it cannot be taken off, if it cannot. */
type Row = {
  repo: string;
  main: boolean;
  pull: PullRequest | undefined;
  checks: string;
  refusal: string;
};

/**
 * The card's repos in the order the engine keeps them. The engine leaves `repos` empty for a
 * card whose only repo is its issue's, so that one is read from the issue.
 */
function rowsOf(card: Card): Row[] {
  if (card.repos.length > 0)
    return card.repos.map((entry, at) => ({
      repo: entry.repo ? `${entry.repo.owner}/${entry.repo.repo}` : "",
      main: entry.main,
      pull: entry.pullRequest ?? (at === 0 ? card.pullRequest : undefined),
      checks: entry.checks,
      refusal: entry.removeRefusal,
    }));
  const repo = repoOf(card);
  return repo
    ? [
        {
          repo,
          main: true,
          pull: card.pullRequest,
          checks: card.pullRequest?.checks ?? "",
          refusal: "it is the repo of the card's issue",
        },
      ]
    : [];
}

/** `owner/name` with the characters GitHub allows in each part. The engine checks the rest. */
const REPO = /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/**
 * The repos a card works in. A run works in the first one and reads the others as context. A
 * person who can run adds a repo as `owner/name` and takes an extra one off; the engine's words
 * show when it refuses either, and a repo it will not let go says why beside its row.
 */
export function ReposTab({
  client,
  card,
  canRun,
  onChanged,
}: {
  client: Client;
  card: Card;
  canRun: boolean;
  /** The engine changed the card's repos and answered with the card as it now stands. */
  onChanged(card: Card): void;
}) {
  const rows = rowsOf(card);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();

  const remove = async (repo: string) => {
    if (pending) return;
    setPending(repo);
    setError(undefined);
    try {
      onChanged(await client.removeIssueRepo(card.id, repo));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="beehive-repos">
      <div className="beehive-repos-head">
        <p className="text-body-sm text-subtle">
          A run works in the first repo. The others are context the agent can
          read.
        </p>
        {canRun && (
          <Button
            disabled={!!pending}
            onClick={() => {
              setError(undefined);
              setAdding(true);
            }}
          >
            Add repo
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-subtle">No repos on this card.</p>
      ) : (
        <ol className="beehive-repo-list" aria-label="Repos of the card">
          {rows.map((row, at) => (
            <li key={row.repo}>
              <span className="text-label">{`${at + 1}. ${row.repo}`}</span>
              {row.main && (
                <span className="text-body-sm text-subtle">Main</span>
              )}
              {row.pull && (
                <span className="text-body-sm">
                  {isWebUrl(row.pull.url) ? (
                    <Button
                      variant="link"
                      size="text"
                      role="link"
                      nativeButton={false}
                      render={
                        <a
                          href={row.pull.url}
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      {`#${row.pull.number}`}
                    </Button>
                  ) : (
                    `#${row.pull.number}`
                  )}
                  {` ${pullState(row.pull.state, row.pull.draft)}`}
                  {row.checks && ` · checks ${row.checks}`}
                </span>
              )}
              {canRun && (
                <Button
                  size="sm"
                  aria-label={`Remove ${row.repo}`}
                  loading={pending === row.repo}
                  disabled={!!pending || !!row.refusal}
                  onClick={() => void remove(row.repo)}
                >
                  Remove
                </Button>
              )}
              {canRun && row.refusal && (
                <span className="beehive-repo-refusal text-body-sm text-subtle">
                  {`Cannot remove: ${row.refusal}.`}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {adding && (
        <AddRepoDialog
          client={client}
          cardId={card.id}
          onClose={() => setAdding(false)}
          onAdded={(next) => {
            setAdding(false);
            onChanged(next);
          }}
        />
      )}
    </div>
  );
}

const FORM = "beehive-add-repo";

/** A repo typed as `owner/name`, checked here for its shape and by the engine for the rest. */
function AddRepoDialog({
  client,
  cardId,
  onClose,
  onAdded,
}: {
  client: Client;
  cardId: string;
  onClose(): void;
  onAdded(card: Card): void;
}) {
  const [repo, setRepo] = useState("");
  const [shape, setShape] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const typed = repo.trim();
    if (!REPO.test(typed)) {
      setShape("Type the repo as owner/name.");
      return;
    }
    setShape(undefined);
    setError(undefined);
    setPending(true);
    try {
      onAdded(await client.addIssueRepo(cardId, typed));
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      size="compact"
      title="Add repo"
      description="Beehive checks that the team's GitHub token can read it."
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
            Add repo
          </Button>
        </>
      }
    >
      <form id={FORM} onSubmit={submit} noValidate className="beehive-form">
        <Field label="Repo" description="Type owner/name." error={shape}>
          <Input
            value={repo}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => {
              setRepo(event.target.value);
              setShape(undefined);
            }}
          />
        </Field>
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
