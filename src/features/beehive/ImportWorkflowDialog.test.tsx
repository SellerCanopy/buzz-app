// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import type { Client } from "./engine/client";
import { EngineError } from "./engine/transport";
import { WorkflowSchema } from "./gen/kiln/engine/v1/engine_pb";
import { ImportWorkflowDialog } from "./ImportWorkflowDialog";

afterEach(cleanup);

const zip = () =>
  new File([new Uint8Array([80, 75])], "flow.zip", { type: "application/zip" });

function open(importWorkflow: (zip: Uint8Array) => Promise<unknown>) {
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(
    <ImportWorkflowDialog
      client={{ importWorkflow } as unknown as Client}
      onImported={onImported}
      onClose={onClose}
    />,
  );
  return { onImported, onClose };
}

it("sends the chosen zip and reports the name the engine gave the workflow", async () => {
  const importWorkflow = vi.fn(async (_zip: Uint8Array) =>
    create(WorkflowSchema, { name: "flow" }),
  );
  const { onImported } = open(importWorkflow);
  const dialog = await screen.findByRole("dialog", {
    name: "Import a workflow",
  });
  fireEvent.change(within(dialog).getByLabelText("Workflow zip"), {
    target: { files: [zip()] },
  });
  await waitFor(() => expect(onImported).toHaveBeenCalledWith("flow"));
  expect(importWorkflow.mock.calls[0]?.[0]).toEqual(new Uint8Array([80, 75]));
});

it("keeps the dialog open with the engine's reason when the zip is refused", async () => {
  const { onImported, onClose } = open(async () => {
    throw new EngineError(
      "already_exists",
      "a workflow named flow already exists",
      409,
    );
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Import a workflow",
  });
  fireEvent.change(within(dialog).getByLabelText("Workflow zip"), {
    target: { files: [zip()] },
  });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "already exists",
  );
  expect(onImported).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("closes on Cancel without calling the engine", async () => {
  const importWorkflow = vi.fn();
  const { onClose } = open(importWorkflow);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalled();
  expect(importWorkflow).not.toHaveBeenCalled();
});
