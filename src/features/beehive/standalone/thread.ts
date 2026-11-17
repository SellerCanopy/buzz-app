/** Hands a stage's thread to the app's own thread view, when the app provides one. */
export function openNativeThread(channelId: string, rootEventId: string) {
  window.__beehiveNative?.openThread?.(channelId, rootEventId);
}
