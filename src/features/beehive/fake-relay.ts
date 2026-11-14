import type { RelayData } from "../relay/service";

type FakeChannel = {
  id: string;
  name: string;
  channelType?: "stream" | "forum" | "dm" | "solo" | "system";
  archived?: true;
};

/** A connected relay whose channel list is `channels`, for tests and the offline fixture. */
export const FAKE_VIEWER = "a".repeat(64);
export const FAKE_ORIGIN = "https://relay.example.org";

export function fakeRelay(channels: FakeChannel[]): RelayData {
  const list = {
    status: "ready" as const,
    channels: channels.map((channel) => ({
      channelType: "stream" as const,
      ...channel,
    })),
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `${FAKE_ORIGIN}:${FAKE_VIEWER}`,
    origin: FAKE_ORIGIN,
    viewer: FAKE_VIEWER,
    session: {
      scope: `${FAKE_ORIGIN}:${FAKE_VIEWER}`,
      channels: {
        list: () => list,
        subscribeList: () => () => {},
        ensureList: () => () => {},
      },
      media: (url: string) => url,
    },
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry: () => {},
    tryAgain: () => {},
    disconnect: () => {},
    clearCache: async () => {},
  } as unknown as RelayData;
}
