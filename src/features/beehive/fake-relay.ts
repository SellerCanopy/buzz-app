import type { RelayData } from "../relay/service";

type FakeChannel = {
  id: string;
  name: string;
  channelType?: "stream" | "forum" | "dm" | "solo" | "system";
  archived?: true;
};

/** A connected relay whose channel list is `channels`, for tests and the offline fixture. */
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
    session: {
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
