import { Button } from "../../shared/design-system/ui/Button";
import type { Navigation } from "../navigation/controller";
import type { NavigationScope } from "../navigation/targets";
import type { StageThread } from "./gen/kiln/engine/v1/engine_pb";

/**
 * Opens a stage's thread in its channel. The caller has already found that the
 * person can read the channel, and passes the scope that read used.
 */
export function OpenThreadLink({
  navigator,
  scope,
  thread,
}: {
  navigator: Navigation | undefined;
  scope: NavigationScope;
  thread: StageThread;
}) {
  if (!navigator) return null;
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
