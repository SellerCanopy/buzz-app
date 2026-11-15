import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { columnOf } from "./CardList";
import { CardSchema } from "./gen/kiln/engine/v1/engine_pb";

const card = (workflow: string, state: string) =>
  create(CardSchema, { id: "a", title: "A", workflow, state });

it("puts a card with no workflow in Backlog whatever its state says", () => {
  for (const state of ["idle", "running", "waiting", "failed", "done", ""])
    expect(columnOf(card("", state))).toBe("backlog");
});

it("places a card with a workflow by its state", () => {
  const expected: [string, string][] = [
    ["idle", "todo"],
    ["", "todo"],
    ["running", "running"],
    ["waiting", "waiting"],
    ["failed", "attention"],
    ["stopped", "attention"],
    ["done", "done"],
    // A state this app does not know yet is still on the board.
    ["unheard-of", "todo"],
  ];
  for (const [state, column] of expected)
    expect(columnOf(card("ship", state)), state).toBe(column);
});
