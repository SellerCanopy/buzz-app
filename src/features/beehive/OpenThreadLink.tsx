import { Button } from "../../shared/design-system/ui/Button";
import type { Navigation } from "../navigation/controller";
import type { RelayData } from "../relay/service";
import type { StageThread } from "./gen/kiln/engine/v1/engine_pb";
import { useReadableChannel } from "./useReadableChannel";

/**
 * Opens a stage's thread in its channel. It renders nothing for a person who
 * cannot read the channel, so a card never offers a link that would be refused.
 */
export function OpenThreadLink({
  relay,
  navigator,
  thread,
}: {
  relay: RelayData;
  navigator: Navigation | undefined;
  thread: StageThread;
}) {
  const readable = useReadableChannel(relay, thread.channelId);
  if (readable.status !== "readable" || !navigator) return null;
  const { scope } = readable;
  return (
    <Button
      variant="link"
      onClick={() =>
        void navigator.open({
          version: 1,
          kind: "conversation",
          scope,
          channelId: thread.channelId,
          messageId: thread.rootEventId,
          // The channel shows the thread's root beside it, for its context.
          threadRootId: thread.rootEventId,
          context: "channel",
        })
      }
    >
      Open in channel
    </Button>
  );
}
