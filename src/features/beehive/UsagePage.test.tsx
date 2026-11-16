// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Client } from "./engine/client";
import { GetUsageResponseSchema } from "./gen/kiln/engine/v1/engine_pb";
import { formatDuration, UsagePage } from "./UsagePage";

afterEach(cleanup);

const figure = (scope: HTMLElement, label: string) =>
  within(scope).getByText(label, { selector: "dt" }).nextSibling;

const WEEKS = [
  { starts: "2026-10-26", cardsCreatedByAgents: 0, runsStartedByAgents: 0 },
  { starts: "2026-11-02", cardsCreatedByAgents: 3, runsStartedByAgents: 1 },
  { starts: "2026-11-09", cardsCreatedByAgents: 1, runsStartedByAgents: 4 },
];

function usage(fields: MessageInitShape<typeof GetUsageResponseSchema> = {}) {
  const getUsage = vi.fn(async () =>
    create(GetUsageResponseSchema, {
      runs: 7,
      endedRuns: 5,
      averageRunSeconds: 75n,
      longestRunSeconds: 3700n,
      weeks: WEEKS,
      ...fields,
    }),
  );
  render(<UsagePage client={{ getUsage } as unknown as Client} />);
  return getUsage;
}

it("formats a duration in the largest two units", () => {
  expect(formatDuration(0n)).toBe("0s");
  expect(formatDuration(59n)).toBe("59s");
  expect(formatDuration(75n)).toBe("1m 15s");
  expect(formatDuration(3700n)).toBe("1h 1m");
});

it("shows the runs, how long they took and the agents' weekly counts", async () => {
  usage();
  const runs = await screen.findByRole("region", { name: "Runs" });
  expect(figure(runs, "Runs")).toHaveTextContent("7");
  expect(figure(runs, "Ended")).toHaveTextContent("5");
  expect(figure(runs, "Average run")).toHaveTextContent("1m 15s");
  expect(figure(runs, "Longest run")).toHaveTextContent("1h 1m");

  const table = screen.getByRole("table", {
    name: "Cards created and runs started by agents, for each week",
  });
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows).toHaveLength(3);
  expect(rows[1]).toHaveTextContent(/Nov 2\s*3\s*1/);
  expect(rows[2]).toHaveTextContent(/Nov 9\s*1\s*4/);
});

it("names the weekly section and gives its chart a legend for both series", async () => {
  usage();
  const section = await screen.findByRole("region", {
    name: "Started by agents, by week",
  });
  expect(
    within(section).getByText(
      "Cards agents created and runs agents started, for each week.",
    ),
  ).toBeVisible();
  const legend = within(section).getByRole("list");
  expect(
    within(legend)
      .getAllByRole("listitem")
      .map((entry) => entry.textContent),
  ).toEqual(["Cards created", "Runs started"]);
});

it("says no run has ended rather than showing a zero length", async () => {
  usage({ endedRuns: 0, averageRunSeconds: 0n, longestRunSeconds: 0n });
  const runs = await screen.findByRole("region", { name: "Runs" });
  expect(figure(runs, "Average run")).toHaveTextContent("None yet");
});

it("shows no token or cost figure", async () => {
  usage();
  await screen.findByRole("region", { name: "Runs" });
  expect(document.body.textContent?.toLowerCase()).not.toMatch(
    /token|cost|dollar|price|\$/,
  );
});

it("shows an empty state when nothing has run and agents started nothing", async () => {
  usage({
    runs: 0,
    endedRuns: 0,
    averageRunSeconds: 0n,
    longestRunSeconds: 0n,
    weeks: WEEKS.map((week) => ({
      ...week,
      cardsCreatedByAgents: 0,
      runsStartedByAgents: 0,
    })),
  });
  expect(await screen.findByText("No activity yet")).toBeVisible();
  expect(screen.queryByRole("table")).toBeNull();
});

it("shows the failure and reads again on Retry", async () => {
  const user = userEvent.setup();
  const getUsage = vi
    .fn()
    .mockRejectedValueOnce(new Error("Beehive is not reachable"))
    .mockResolvedValue(create(GetUsageResponseSchema, { runs: 1, weeks: [] }));
  render(<UsagePage client={{ getUsage } as unknown as Client} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("region", { name: "Runs" })).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});
