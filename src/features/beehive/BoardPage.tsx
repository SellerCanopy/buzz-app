import { useCallback, useEffect, useState } from "react";
import { HexagonIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import type { Card } from "./gen/kiln/engine/v1/engine_pb";
import type { Client } from "./engine/client";

type Board =
  | { status: "loading" }
  | { status: "ready"; cards: Card[] }
  | { status: "error"; message: string };

/** The board: every card that is not archived, or an empty state when there are none. */
export function BoardPage({ client }: { client: Client }) {
  const [board, setBoard] = useState<Board>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    // `attempt` restarts the read; it is not otherwise used.
    void attempt;
    const abort = new AbortController();
    setBoard((current) =>
      current.status === "ready" ? current : { status: "loading" },
    );
    client
      .listCards(false, abort.signal)
      .then((reply) => setBoard({ status: "ready", cards: reply.cards }))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setBoard((current) =>
          current.status === "ready"
            ? current
            : {
                status: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Beehive did not answer",
              },
        );
      });
    return () => abort.abort();
  }, [client, attempt]);

  const failed = board.status === "error";
  return (
    <LoadingRegion
      pending={board.status === "loading"}
      label="Loading cards…"
      feedback={
        failed ? (
          <div className="beehive-error">
            <p role="alert" className="text-danger">
              {board.message}
            </p>
            <Button onClick={retry}>Retry</Button>
          </div>
        ) : undefined
      }
    >
      {board.status === "ready" && board.cards.length === 0 && (
        <EmptyState
          icon={<HexagonIcon size="1.5rem" />}
          title="No cards yet"
          description="Cards you add will show up here."
        />
      )}
      {board.status === "ready" && board.cards.length > 0 && (
        <ul aria-label="Cards">
          {board.cards.map((card) => (
            <li key={card.id.toString()}>{card.title}</li>
          ))}
        </ul>
      )}
    </LoadingRegion>
  );
}
