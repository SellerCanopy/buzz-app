import { Button } from "../../shared/design-system/ui/Button";
import { Callout } from "./Callout";

/**
 * The note on the Live tab that the card waits for an approval, with Reject and Approve for a
 * person who can run. `subject` names what is approved, as `plan`.
 */
export function ApprovalCallout({
  subject,
  canRun,
  pending,
  onReject,
  onApprove,
}: {
  subject: string;
  canRun: boolean;
  pending: boolean;
  onReject(): void;
  onApprove(): void;
}) {
  return (
    <Callout
      tone="warning"
      title="Waiting for your approval"
      actions={
        canRun ? (
          <>
            <Button disabled={pending} onClick={onReject}>
              Reject
            </Button>
            <Button variant="prominent" disabled={pending} onClick={onApprove}>
              Approve
            </Button>
          </>
        ) : undefined
      }
    >
      {subject
        ? `Review the ${subject}, then approve it or send it back with a note.`
        : "Review it, then approve it or send it back with a note."}
    </Callout>
  );
}
