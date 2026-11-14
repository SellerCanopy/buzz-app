import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
  CardSchema,
  EventSchema,
  type Card,
} from "../gen/kiln/engine/v1/engine_pb";
import { applyEvents } from "./useLive";

const event = (type: string, cardId: string, payload: object = {}) =>
  create(EventSchema, {
    type,
    cardId,
    seq: 1n,
    payloadJson: JSON.stringify(payload),
  });
const titles = (cards: Card[]) => cards.map((c) => c.title);
const existing = create(CardSchema, { id: "a", title: "Old", state: "idle" });

it("puts a created card first on the board and not in the archive", () => {
  const created = event("card.created", "b", {
    title: "New",
    workflow: "",
    state: "idle",
  });
  expect(titles(applyEvents([existing], [created], false))).toEqual([
    "New",
    "Old",
  ]);
  expect(applyEvents([], [created], true)).toEqual([]);
});

it("is idempotent: the same events twice leave the same list", () => {
  const events = [
    event("card.created", "b", { title: "New", workflow: "", state: "idle" }),
    event("card.state", "b", { state: "running" }),
    event("card.moved", "b", { workflow: "ship" }),
  ];
  const once = applyEvents([existing], events, false);
  const twice = applyEvents(once, events, false);
  expect(twice).toEqual(once);
  expect(once[0]).toMatchObject({
    id: "b",
    state: "running",
    workflow: "ship",
  });
});

it("moves a card between the board and the archive", () => {
  const archived = event("card.archived", "a", { title: "Old" });
  expect(applyEvents([existing], [archived], false)).toEqual([]);
  const inArchive = applyEvents([], [archived], true);
  expect(inArchive[0]).toMatchObject({ id: "a", archived: true });
  const restored = event("card.restored", "a", { title: "Old" });
  expect(applyEvents(inArchive, [restored], true)).toEqual([]);
  expect(applyEvents([], [restored], false)[0]).toMatchObject({
    id: "a",
    archived: false,
  });
});

it("removes a deleted card from either view and ignores unknown events", () => {
  expect(applyEvents([existing], [event("card.removed", "a")], false)).toEqual(
    [],
  );
  const unknown = event("run.started", "a");
  expect(applyEvents([existing], [unknown], false)).toEqual([existing]);
});

it("applies a change in order when a card is created and archived in one batch", () => {
  const batch = [
    event("card.created", "b", { title: "New", state: "idle" }),
    event("card.archived", "b", { title: "New", state: "idle" }),
  ];
  expect(applyEvents([], batch, false)).toEqual([]);
  expect(titles(applyEvents([], batch, true))).toEqual(["New"]);
});
