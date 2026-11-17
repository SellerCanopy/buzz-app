import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { HexagonIcon, LockIcon } from "../../shared/design-system/icons";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Select } from "../../shared/design-system/ui/Select";
import type { EmbeddedThreadProps } from "../conversation/EmbeddedThread";
import type { Navigation } from "../navigation/controller";
import type { RelayData } from "../relay/service";
import type { ReactNode } from "react";
import type { Card, StageThread } from "./gen/kiln/engine/v1/engine_pb";
import { OpenThreadLink } from "./OpenThreadLink";
import { useReadableChannel, type ReadableChannel } from "./useReadableChannel";

const keyOf = (thread: StageThread) => `${thread.stage}:${thread.visit}`;

/** The thread of the stage the card is in now, or the newest one when it is in none. */
function currentThread(card: Card): StageThread | undefined {
  const inStage = card.stages.filter((s) => s.stage === card.stageId);
  return inStage.at(-1) ?? card.stages.at(-1);
}

/** Reads whether the person can read a channel, for the render below it. */
function Readable({
  relay,
  channelId,
  children,
}: {
  relay: RelayData;
  channelId: string;
  children(readable: ReadableChannel): ReactNode;
}) {
  return children(useReadableChannel(relay, channelId));
}

/**
 * The current stage's relay thread, embedded as Channels shows it, so a person
 * reads and answers in place. A picker reaches the threads of earlier stages.
 * Without a relay (the standalone page) nothing can be embedded or gated, so
 * the picker shows beside a button that hands the thread to `onOpenThread`.
 */
export function LiveTab({
  card,
  relay,
  navigator,
  Thread,
  onOpenThread,
}: {
  card: Card;
  relay: RelayData | undefined;
  navigator: Navigation | undefined;
  Thread: (props: EmbeddedThreadProps) => ReactNode;
  onOpenThread?: ((channelId: string, rootEventId: string) => void) | undefined;
}) {
  const [picked, setPicked] = useState<string>();
  const current = currentThread(card);
  const thread = card.stages.find((s) => keyOf(s) === picked) ?? current;

  if (!thread)
    return (
      <EmptyState
        icon={<HexagonIcon size="1.5rem" />}
        title="Nothing running"
        description="A stage's thread shows up here once a run starts."
      />
    );
  const options = card.stages.map((s) => ({
    value: keyOf(s),
    label: s.visit > 1 ? `${s.stage} (visit ${s.visit})` : s.stage,
    ...(current && keyOf(s) === keyOf(current)
      ? { description: "Current" }
      : {}),
  }));
  const shell = (link: ReactNode, body?: ReactNode) => (
    <div className="beehive-live">
      <div className="beehive-live-bar">
        {card.stages.length > 1 && (
          <Select
            label="Stage"
            value={keyOf(thread)}
            onValueChange={setPicked}
            groups={[{ label: "Stages", options }]}
          />
        )}
        {link}
      </div>
      {body}
    </div>
  );
  if (!relay)
    return shell(
      onOpenThread && (
        <Button
          variant="link"
          onClick={() => onOpenThread(thread.channelId, thread.rootEventId)}
        >
          Open thread
        </Button>
      ),
    );
  return (
    <Readable relay={relay} channelId={thread.channelId}>
      {(readable) => {
        if (readable.status === "waiting")
          return (
            <p role="status" className="text-subtle">
              Connecting to the community…
            </p>
          );
        if (readable.status === "denied")
          return (
            <EmptyState
              icon={<LockIcon size="1.5rem" />}
              title="No access to the channel"
              description="This stage posts in a channel you are not in. Ask a member to add you."
            />
          );
        return shell(
          <OpenThreadLink
            navigator={navigator}
            scope={readable.scope}
            thread={thread}
          />,
          <div className="beehive-live-thread">
            <Thread
              key={`${thread.channelId}:${thread.rootEventId}`}
              session={readable.session}
              scope={readable.session.scope}
              channelId={thread.channelId}
              channelName={readable.channel.name}
              messageId={thread.rootEventId}
            />
          </div>,
        );
      }}
    </Readable>
  );
}
