import { useEffect, useState } from "react";
import { HexagonIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { formatPublicKey } from "../../shared/identity/public-key";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type {
  ActivityAuthor,
  ActivityEntry,
} from "./gen/kiln/engine/v1/engine_pb";

type Listing =
  | { status: "loading" }
  | { status: "ready"; entries: ActivityEntry[] }
  | { status: "error"; message: string };

/** Who wrote an entry: a person or an agent by its short key, or Beehive itself. */
export function authorLabel(author: ActivityAuthor | undefined): string {
  if (!author || author.kind === "kiln") return "Beehive";
  const key = formatPublicKey(author.id);
  const who = author.kind === "agent" ? "Agent" : "Person";
  return key ? `${who} ${key}` : who;
}

const when = (entry: ActivityEntry) =>
  entry.at
    ? new Date(Number(entry.at.seconds) * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";

/**
 * What happened on a card, newest first: notes, the answers people gave to approvals and
 * questions with their reasons, and what the stages logged. Each entry says who wrote it.
 */
export function ActivityTab({
  client,
  cardId,
}: {
  client: Client;
  cardId: string;
}) {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `attempt` re-reads the list after a failure.
    void attempt;
    const abort = new AbortController();
    setListing({ status: "loading" });
    client
      .listActivity(cardId, abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        setListing({ status: "ready", entries: [...reply.entries].reverse() });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setListing({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, cardId, attempt]);

  const entries = listing.status === "ready" ? listing.entries : [];
  return (
    <LoadingRegion
      pending={listing.status === "loading"}
      label="Loading activity…"
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
      {listing.status === "ready" && entries.length === 0 && (
        <EmptyState
          icon={<HexagonIcon size="1.5rem" />}
          title="No activity yet"
          description="Notes, answers to approvals and questions, and what the stages log show up here."
        />
      )}
      {entries.length > 0 && (
        <ol className="beehive-activity" aria-label="Activity">
          {entries.map((entry) => (
            <li key={entry.key || String(entry.seq)}>
              <span>{entry.summary}</span>
              <span className="text-body-sm text-subtle">
                {[authorLabel(entry.author), when(entry)]
                  .filter(Boolean)
                  .join(", ")}
              </span>
              {entry.detail && (
                <span className="beehive-step-summary text-body-sm">
                  {entry.detail}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </LoadingRegion>
  );
}
