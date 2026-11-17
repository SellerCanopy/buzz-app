// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { Navigation } from "../navigation/controller";
import { FAKE_ORIGIN, FAKE_VIEWER, fakeRelay } from "./fake-relay";
import { CardSchema, StageThreadSchema } from "./gen/kiln/engine/v1/engine_pb";
import { LiveTab } from "./LiveTab";

afterEach(cleanup);

const CHANNEL = "5f1c2d3e-0000-4000-8000-000000000001";
const ELSEWHERE = "5f1c2d3e-0000-4000-8000-000000000009";
const BUILD = "aa".repeat(32);
const REVIEW = "bb".repeat(32);
const BUILD_AGAIN = "cc".repeat(32);

const thread = (
  stage: string,
  visit: number,
  rootEventId: string,
  channelId = CHANNEL,
) => create(StageThreadSchema, { stage, visit, rootEventId, channelId });

const Thread = (props: {
  channelId: string;
  channelName: string;
  messageId: string;
}) => (
  <div
    data-testid="thread"
    data-channel={props.channelId}
    data-name={props.channelName}
  >
    {props.messageId}
  </div>
);

function show(
  stages: ReturnType<typeof thread>[],
  stageId = "review",
  member = [{ id: CHANNEL, name: "updates" }],
) {
  const navigator = { open: vi.fn(async () => ({})) };
  render(
    <LiveTab
      card={create(CardSchema, { id: "card", stageId, stages })}
      relay={fakeRelay(member)}
      navigator={navigator as unknown as Navigation}
      Thread={Thread as never}
    />,
  );
  return navigator;
}

it("embeds the current stage's thread by its root", () => {
  show([thread("build", 1, BUILD), thread("review", 1, REVIEW)]);
  expect(screen.getByTestId("thread")).toHaveTextContent(REVIEW);
  expect(screen.getByTestId("thread")).toHaveAttribute("data-name", "updates");
  expect(screen.getByTestId("thread")).toHaveAttribute("data-channel", CHANNEL);
});

it("lists one entry per stage visit and switches to the one chosen", async () => {
  show(
    [
      thread("build", 1, BUILD),
      thread("review", 1, REVIEW),
      thread("build", 2, BUILD_AGAIN),
    ],
    "build",
  );
  // A card back in `build` shows the newest build thread.
  expect(screen.getByTestId("thread")).toHaveTextContent(BUILD_AGAIN);
  await userEvent.click(screen.getByRole("combobox", { name: "Stage" }));
  expect(await screen.findAllByRole("option")).toHaveLength(3);
  expect(
    screen.getByRole("option", { name: /build \(visit 2\)/ }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("option", { name: /^review/ }));
  expect(await screen.findByTestId("thread")).toHaveTextContent(REVIEW);
});

it("opens the thread in its channel from the link", async () => {
  const navigator = show([thread("build", 1, BUILD)], "build");
  await userEvent.click(
    screen.getByRole("button", { name: "Open in channel" }),
  );
  expect(navigator.open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    scope: { viewer: FAKE_VIEWER, communityOrigin: FAKE_ORIGIN },
    channelId: CHANNEL,
    messageId: BUILD,
    threadRootId: BUILD,
    context: "channel",
  });
});

it("shows neither the thread nor the link to someone not in the channel", () => {
  show([thread("build", 1, BUILD, ELSEWHERE)], "build");
  expect(screen.getByText("No access to the channel")).toBeVisible();
  expect(screen.queryByTestId("thread")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in channel" })).toBeNull();
});

it("says nothing is running when no stage has a thread", () => {
  show([]);
  expect(screen.getByText("Nothing running")).toBeVisible();
  expect(screen.queryByTestId("thread")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("without a relay shows the picker and hands the thread to the host", async () => {
  const onOpenThread = vi.fn();
  render(
    <LiveTab
      card={create(CardSchema, {
        id: "card",
        stageId: "review",
        stages: [thread("build", 1, BUILD), thread("review", 1, REVIEW)],
      })}
      relay={undefined}
      navigator={undefined}
      Thread={Thread as never}
      onOpenThread={onOpenThread}
    />,
  );
  expect(screen.queryByTestId("thread")).toBeNull();
  expect(screen.queryByText("Connecting to the community…")).toBeNull();
  expect(screen.queryByText("No access to the channel")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open thread" }));
  expect(onOpenThread).toHaveBeenCalledWith(CHANNEL, REVIEW);
  await userEvent.click(screen.getByRole("combobox", { name: "Stage" }));
  await userEvent.click(await screen.findByRole("option", { name: /^build/ }));
  await userEvent.click(screen.getByRole("button", { name: "Open thread" }));
  expect(onOpenThread).toHaveBeenLastCalledWith(CHANNEL, BUILD);
});

it("without a relay or a host to hand the thread to shows no link", () => {
  render(
    <LiveTab
      card={create(CardSchema, {
        id: "card",
        stageId: "build",
        stages: [thread("build", 1, BUILD), thread("review", 1, REVIEW)],
      })}
      relay={undefined}
      navigator={undefined}
      Thread={Thread as never}
    />,
  );
  // The stage picker still shows, with nothing to embed, wait for or open.
  expect(screen.getByRole("combobox", { name: "Stage" })).toHaveTextContent(
    "build",
  );
  expect(screen.queryByRole("button", { name: "Open thread" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in channel" })).toBeNull();
  expect(screen.queryByTestId("thread")).toBeNull();
  expect(screen.queryByText("Connecting to the community…")).toBeNull();
  expect(screen.queryByText("No access to the channel")).toBeNull();
  expect(screen.queryByText("Nothing running")).toBeNull();
});
