// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  EventSchema,
  InboxItemSchema,
  type InboxItem,
} from "../gen/kiln/engine/v1/engine_pb";
import type { Client } from "./client";
import { EngineError } from "./transport";
import { useInbox } from "./useInbox";

afterEach(cleanup);

const item = (id: string) => create(InboxItemSchema, { id, title: id });

type PollReply = { events: ReturnType<typeof create>[]; nextSeq: bigint };

/** A client whose inbox answers from `lists` in order, and whose polls park for the test. */
function inboxClient(lists: InboxItem[][]) {
  const polls: {
    after: bigint;
    resolve(reply: PollReply): void;
    reject(error: Error): void;
  }[] = [];
  let read = 0;
  const client = {
    listInbox: vi.fn(async () => ({
      items: lists[Math.min(read++, lists.length - 1)] ?? [],
      seq: 5n,
    })),
    pollEvents: vi.fn(
      (after: bigint) =>
        new Promise((resolve, reject) => {
          polls.push({ after, resolve, reject });
        }),
    ),
  };
  return { client: client as unknown as Client, calls: client, polls };
}

const ids = (inbox: ReturnType<typeof useInbox>["inbox"]) =>
  inbox.status === "ready" ? inbox.items.map((i) => i.id) : [];

it("reads the list once and follows the log from that read", async () => {
  const { client, calls, polls } = inboxClient([[item("a")]]);
  const { result } = renderHook(() => useInbox(client));
  await waitFor(() => expect(ids(result.current.inbox)).toEqual(["a"]));
  await waitFor(() => expect(polls).toHaveLength(1));
  expect(polls[0]?.after).toBe(5n);
  await act(async () => {
    polls[0]?.resolve({
      events: [create(EventSchema, { type: "inbox.opened", seq: 6n })],
      nextSeq: 6n,
    });
  });
  await waitFor(() => expect(calls.listInbox).toHaveBeenCalledTimes(2));
});

it("follows the log again from a later read once a refusal ended the poll, and lifts the pause", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { client, polls } = inboxClient([[item("a")], [item("b")]]);
  const { result } = renderHook(() => useInbox(client));
  await waitFor(() => expect(polls).toHaveLength(1));
  await act(async () => {
    polls[0]?.reject(new EngineError("permission_denied", "no access", 403));
  });
  expect(result.current.inbox).toMatchObject({
    status: "ready",
    paused: "Live updates paused: no access",
  });
  // An answer reads the list again: it is shown, the log is followed again, the pause is gone.
  act(() => result.current.refresh());
  await waitFor(() => expect(ids(result.current.inbox)).toEqual(["b"]));
  await waitFor(() => expect(polls).toHaveLength(2));
  expect(result.current.inbox).not.toHaveProperty("paused");
  warn.mockRestore();
});

it("does not follow again on a read while the poll is healthy", async () => {
  const { client, polls } = inboxClient([[item("a")], [item("b")]]);
  const { result } = renderHook(() => useInbox(client));
  await waitFor(() => expect(polls).toHaveLength(1));
  act(() => result.current.refresh());
  await waitFor(() => expect(ids(result.current.inbox)).toEqual(["b"]));
  expect(polls).toHaveLength(1);
});
