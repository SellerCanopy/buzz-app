import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
  canMerge,
  canPause,
  canRetry,
  canStart,
  canStop,
  isWebUrl,
} from "./cardActions";
import { CardSchema, RunSchema } from "./gen/kiln/engine/v1/engine_pb";

const card = (fields: Record<string, unknown> = {}) =>
  create(CardSchema, { id: "a", workflow: "ship", state: "idle", ...fields });
const run = (state: string) => create(RunSchema, { id: "r", state });

it("starts only an idle card with a workflow that is on the board", () => {
  expect(canStart(card())).toBe(true);
  expect(canStart(card({ workflow: "" }))).toBe(false);
  expect(canStart(card({ state: "running" }))).toBe(false);
  expect(canStart(card({ archived: true }))).toBe(false);
});

it("stops a run that has not ended and holds one that is working", () => {
  expect(canStop(run("paused"))).toBe(true);
  expect(canStop(run("ended"))).toBe(false);
  expect(canPause(card(), run("running"))).toBe(true);
  expect(canPause(card(), run("paused"))).toBe(false);
  expect(canPause(card(), undefined)).toBe(false);
});

it("retries a failed or stopped card whose run ended", () => {
  expect(canRetry(card({ state: "failed" }), run("ended"))).toBe(true);
  expect(canRetry(card({ state: "stopped" }), run("ended"))).toBe(true);
  expect(canRetry(card({ state: "failed" }), run("running"))).toBe(false);
  expect(canRetry(card({ state: "done" }), run("ended"))).toBe(false);
  expect(canRetry(card({ state: "failed" }), undefined)).toBe(false);
});

it("merges only an open pull request that is out of draft and not failing or pending", () => {
  const pull = (fields = {}) =>
    card({
      pullRequest: {
        number: 1,
        url: "u",
        state: "open",
        draft: false,
        ...fields,
      },
    });
  expect(canMerge(pull({ checks: "passing" }))).toBe(true);
  expect(canMerge(pull())).toBe(true);
  expect(canMerge(pull({ draft: true }))).toBe(false);
  expect(canMerge(pull({ checks: "failing" }))).toBe(false);
  expect(canMerge(pull({ checks: "pending" }))).toBe(false);
  expect(canMerge(pull({ state: "merged" }))).toBe(false);
  expect(canMerge(card())).toBe(false);
});

it("links only a web address", () => {
  expect(isWebUrl("https://github.example.org/a")).toBe(true);
  expect(isWebUrl("javascript:alert(1)")).toBe(false);
  expect(isWebUrl("")).toBe(false);
});
