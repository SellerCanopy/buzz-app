// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ActivityTab, authorLabel } from "./ActivityTab";
import type { Client } from "./engine/client";
import {
  ActivityAuthorSchema,
  ActivityEntrySchema,
  ListActivityResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";

afterEach(cleanup);

const OWNER = "a".repeat(64);

const entry = (seq: bigint, fields: Record<string, unknown>) =>
  create(ActivityEntrySchema, { seq, key: `k${seq}`, ...fields });

function tab(entries = [] as ReturnType<typeof entry>[]) {
  const listActivity = vi.fn(async () =>
    create(ListActivityResponseSchema, { entries, seq: 9n }),
  );
  render(
    <ActivityTab client={{ listActivity } as unknown as Client} cardId="c" />,
  );
  return listActivity;
}

it("shows an answer with who gave it and the reason, newest first", async () => {
  const listActivity = tab([
    entry(1n, {
      type: "note",
      summary: "Started",
      author: create(ActivityAuthorSchema, { kind: "kiln" }),
    }),
    entry(2n, {
      type: "answer",
      summary: "Rejected the approval",
      detail: "Add a rollback step.",
      author: create(ActivityAuthorSchema, { kind: "person", id: OWNER }),
    }),
  ]);
  const list = await screen.findByRole("list", { name: "Activity" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("Rejected the approval");
  expect(rows[0]).toHaveTextContent("Add a rollback step.");
  expect(rows[0]).toHaveTextContent(/Person npub…\w{3}/);
  expect(rows[1]).toHaveTextContent("Started");
  expect(rows[1]).toHaveTextContent("Beehive");
  expect(listActivity).toHaveBeenCalledWith("c", expect.anything());
});

it("shows an answer auto mode gave as Beehive's, with the reason", async () => {
  tab([
    entry(1n, {
      type: "auto",
      summary: "auto mode: Approved the approval",
      detail: "approved plan v1",
      author: create(ActivityAuthorSchema, { kind: "kiln", id: OWNER }),
    }),
  ]);
  const row = await screen.findByRole("listitem");
  expect(row).toHaveTextContent("auto mode: Approved the approval");
  expect(row).toHaveTextContent("approved plan v1");
  expect(row).toHaveTextContent("Beehive");
  expect(row).not.toHaveTextContent("npub");
});

it("names an agent and never prints the raw key", () => {
  expect(
    authorLabel(create(ActivityAuthorSchema, { kind: "agent", id: OWNER })),
  ).toMatch(/^Agent npub…\w{3}$/);
  expect(
    authorLabel(create(ActivityAuthorSchema, { kind: "agent", id: "nope" })),
  ).toBe("Agent");
  expect(authorLabel(undefined)).toBe("Beehive");
});

it("says so when a card has no activity", async () => {
  tab();
  expect(await screen.findByText("No activity yet")).toBeVisible();
});

it("shows the failure and reads again on Retry", async () => {
  const user = userEvent.setup();
  const listActivity = vi
    .fn()
    .mockRejectedValueOnce(new Error("Beehive is not reachable"))
    .mockResolvedValue(create(ListActivityResponseSchema, { entries: [] }));
  render(
    <ActivityTab client={{ listActivity } as unknown as Client} cardId="c" />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No activity yet")).toBeVisible();
});
