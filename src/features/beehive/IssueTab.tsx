import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { Card, IssueComment } from "./gen/kiln/engine/v1/engine_pb";

type Listing =
  | { status: "loading" }
  | { status: "ready"; comments: IssueComment[]; truncated: boolean }
  | { status: "error"; message: string };

const stamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const when = (comment: IssueComment) =>
  comment.at ? stamp.format(new Date(Number(comment.at.seconds) * 1000)) : "";

/** The issue as people name it: `owner/repo#number`. */
export function issueName(card: Card): string {
  const ref = card.issue;
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}` : "";
}

/** The values of `Card.intake_status` the engine's proto documents. */
type IntakeStatus = "closed" | "reassigned" | "unmatched";

/** Why a card's issue is no longer taken by its rule, in words a person reads. */
const LEFT: Record<IntakeStatus, string> = {
  closed: "The issue was closed.",
  reassigned: "The issue was assigned to someone else.",
  unmatched: "The issue no longer matches the rule that brought it.",
};

/** Words for a status; one the app does not know yet is shown as the engine wrote it. */
const leftText = (status: string) =>
  (LEFT as Record<string, string | undefined>)[status] ?? status;

/**
 * The issue a card came from: its title, labels and text as the host last returned them, and
 * its newest comments. Everything here was written outside Beehive, by people who may be outside
 * the team, so it is shown as plain text and never as markup or a link.
 */
export function IssueTab({ client, card }: { client: Client; card: Card }) {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `attempt` reads the comments again after a failure.
    void attempt;
    const abort = new AbortController();
    setListing({ status: "loading" });
    client
      .listIssueComments(card.id, abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        setListing({
          status: "ready",
          comments: reply.comments,
          truncated: reply.truncated,
        });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setListing({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, card.id, attempt]);

  return (
    <div className="beehive-issue">
      <dl className="beehive-details">
        <div>
          <dt className="text-label text-subtle">Issue</dt>
          <dd>{issueName(card)}</dd>
        </div>
        {card.issueLabels.length > 0 && (
          <div>
            <dt className="text-label text-subtle">Labels</dt>
            <dd>{card.issueLabels.join(", ")}</dd>
          </div>
        )}
        {card.intakeStatus && (
          <div>
            <dt className="text-label text-subtle">Intake</dt>
            <dd>{leftText(card.intakeStatus)}</dd>
          </div>
        )}
        <div>
          <dt className="text-label text-subtle">Text</dt>
          <dd className="beehive-description">{card.body || "No text."}</dd>
        </div>
      </dl>
      <LoadingRegion
        pending={listing.status === "loading"}
        label="Loading comments…"
        feedback={
          listing.status === "error" ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {listing.message}
              </p>
              <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {listing.status === "ready" && (
          <section aria-label="Comments" className="beehive-comments">
            {listing.comments.length === 0 ? (
              <p className="text-subtle">No comments on the issue.</p>
            ) : (
              <ol className="beehive-activity">
                {listing.comments.map((comment) => (
                  <li key={comment.id}>
                    <span className="text-body-sm text-subtle">
                      {[
                        comment.fromHive ? "Beehive" : comment.author,
                        when(comment),
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                    <span className="beehive-step-summary">{comment.body}</span>
                  </li>
                ))}
              </ol>
            )}
            {listing.truncated && (
              <p className="text-body-sm text-subtle">
                The issue has more comments. These are the newest.
              </p>
            )}
          </section>
        )}
      </LoadingRegion>
    </div>
  );
}
