import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { OpenProposal } from "./gen/kiln/engine/v1/engine_pb";

/**
 * A ticket an agent found and offered, for the person it was offered to. Open issue files it:
 * Beehive opens the issue on the repo and adds the card. Discard keeps nothing. The title and
 * text come from an agent, so they show as plain text.
 */
export function AssistantTicket({
  client,
  proposal,
  canRun,
  onDecided,
}: {
  client: Client;
  proposal: OpenProposal;
  canRun: boolean;
  onDecided(id: bigint, applied: boolean): void;
}) {
  const ticket = proposal.ticket;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const notify = useToastNotification();

  const decide = async (accepted: boolean) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      if (accepted) {
        await client.acceptTicketProposal(proposal.id);
        notify("Opened the issue and added its card", "success");
      } else {
        await client.resolveProposal(proposal.id, false);
      }
      // A ticket saves no workflow, so the workflow list has nothing to read again.
      onDecided(proposal.id, false);
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  return (
    <section
      className="beehive-proposal"
      aria-label={`Proposed ticket: ${ticket?.title ?? ""}`}
    >
      <div>
        <p className="text-label">Proposed ticket</p>
        <p className="text-body-sm text-subtle">{ticket?.repo}</p>
      </div>
      <p>{ticket?.title}</p>
      {ticket?.body && (
        <p className="beehive-description text-body-sm">{ticket.body}</p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="beehive-callout-actions">
        <Button disabled={pending} onClick={() => void decide(false)}>
          Discard
        </Button>
        <Button
          variant="prominent"
          loading={pending}
          disabled={pending || !canRun}
          onClick={() => void decide(true)}
        >
          Open issue
        </Button>
      </div>
    </section>
  );
}
