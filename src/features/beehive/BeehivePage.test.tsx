// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { BeehivePage } from "./BeehivePage";
import type { Client } from "./engine/client";
import {
  CardSchema,
  ListCardsResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";

afterEach(cleanup);

function client(listCards: Client["listCards"]): Client {
  return { listCards } as Client;
}

it("keeps the header and shows the empty state when there are no cards", async () => {
  render(
    <BeehivePage
      client={client(async () =>
        create(ListCardsResponseSchema, { cards: [] }),
      )}
    />,
  );
  expect(await screen.findByText("No cards yet")).toBeVisible();
  expect(screen.getByRole("region", { name: "Beehive" })).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("lists the cards it is given", async () => {
  render(
    <BeehivePage
      client={client(async () =>
        create(ListCardsResponseSchema, {
          cards: [create(CardSchema, { title: "Fix the build" })],
        }),
      )}
    />,
  );
  expect(await screen.findByText("Fix the build")).toBeVisible();
  expect(screen.queryByText("No cards yet")).toBeNull();
});

it("shows the failure beside the board and retries on request", async () => {
  const listCards = vi
    .fn<Client["listCards"]>()
    .mockRejectedValueOnce(new Error("Beehive is not reachable"))
    .mockResolvedValue(create(ListCardsResponseSchema, { cards: [] }));
  render(<BeehivePage client={client(listCards)} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  expect(screen.queryByText("No cards yet")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No cards yet")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(listCards).toHaveBeenCalledTimes(2);
});
