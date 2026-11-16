import { useChannelList, useRelayConnection } from "../relay/react";
import type { ChannelSummary } from "../relay/contracts";
import { splitPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { NavigationScope } from "../navigation/targets";

export type ReadableChannel =
  /** The relay or the channel list has not answered yet. */
  | { status: "waiting" }
  /** The list answered and this person is not in the channel. */
  | { status: "denied" }
  | {
      status: "readable";
      channel: ChannelSummary;
      session: RelaySession;
      scope: NavigationScope;
    };

/**
 * Whether the signed-in person can read one channel. The engine hands every
 * person who may read a card the same thread pointers, so the relay's own
 * channel list decides what is shown.
 */
export function useReadableChannel(
  relay: RelayData,
  channelId: string,
): ReadableChannel {
  const connection = useRelayConnection(relay);
  const list = useChannelList(connection.session.channels);
  const { viewer, scope } = connection;
  const communityOrigin = scope
    ? splitPartition(scope)?.communityOrigin
    : undefined;
  if (
    connection.status !== "ready" ||
    list.status !== "ready" ||
    !viewer ||
    !communityOrigin
  )
    return { status: "waiting" };
  const channel = list.channels.find((c) => c.id === channelId);
  if (!channel) return { status: "denied" };
  return {
    status: "readable",
    channel,
    session: connection.session,
    scope: { viewer, communityOrigin },
  };
}
