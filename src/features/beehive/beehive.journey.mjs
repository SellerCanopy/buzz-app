import { expect, test } from "../../../tests/browser/playwright-test.mjs";
import { createServer } from "../../../tests/browser/vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "../../../tests/browser/page-errors.mjs";

let server;
let url;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/src/features/beehive/fixture.html`;
});
test.afterAll(async () => {
  await server?.close();
});

test("Beehive signs in and shows an empty board", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane).toBeVisible();
  await expect(pane.getByText("No cards yet")).toBeVisible();
  await expect(pane.getByRole("alert")).toHaveCount(0);
  // The token trade came first, then the board read carried the token.
  const calls = await page.evaluate(() => window.beehiveFixture.calls);
  expect(calls[0]).toBe("/auth/token Nostr fixture");
  expect(calls).toContain(
    "/kiln.engine.v1.EngineService/ListCards bearer fixture-token",
  );
  expect(errors.unexplained()).toEqual([]);
});

test("a failed read shows its error beside the board and Retry recovers", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.beehiveFixture = { listCardsFailures: 1 };
  });
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByRole("alert")).toHaveText("Beehive is not reachable");
  // The header stays mounted and the empty state is not claimed for a failed read.
  await expect(
    pane.getByText("Beehive", { exact: true }).first(),
  ).toBeVisible();
  await expect(pane.getByText("No cards yet")).toHaveCount(0);
  await pane.getByRole("button", { name: "Retry" }).click();
  await expect(pane.getByText("No cards yet")).toBeVisible();
  await expect(pane.getByRole("alert")).toHaveCount(0);
});

test("the empty board is readable in dark appearance and with large text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(url);
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
  });
  const pane = page.getByRole("region", { name: "Beehive" });
  const empty = pane.getByText("No cards yet");
  await expect(empty).toBeVisible();
  const box = await empty.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(420);
});

async function addCard(pane, title) {
  await pane.getByRole("button", { name: "New card" }).first().click();
  const dialog = pane.page().getByRole("dialog", { name: "New card" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Add card" }).click();
  await expect(dialog).toHaveCount(0);
}

test("a person adds a card and sees it on the board, then archives it and sees it leave", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByText("No cards yet")).toBeVisible();

  await addCard(pane, "Fix the build");
  // The new card arrives through the event log, not through the form.
  const backlog = pane.getByRole("region", { name: "Backlog" });
  await expect(backlog.getByText("Fix the build")).toBeVisible();
  await expect(pane.getByText("No cards yet")).toHaveCount(0);

  await pane.getByRole("button", { name: /Fix the build/ }).click();
  await expect(pane.getByRole("tab", { name: "Details" })).toBeVisible();
  await pane.getByRole("button", { name: "Archive" }).click();
  await expect(pane.getByRole("button", { name: "Restore" })).toBeVisible();
  await pane.getByRole("button", { name: "Close card" }).click();

  await expect(pane.getByText("No cards yet")).toBeVisible();
  await expect(pane.getByText("Fix the build")).toHaveCount(0);
  await pane.getByRole("tab", { name: "Archive" }).click();
  await expect(pane.getByText("Fix the build")).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});

test("a card is a visit: Back returns to the board and Forward to the card", async ({
  page,
}) => {
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await addCard(pane, "Write the docs");
  await pane.getByRole("button", { name: /Write the docs/ }).click();
  await expect(pane.getByRole("tab", { name: "Details" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(pane.getByRole("tab", { name: "Details" })).toHaveCount(0);
  await expect(pane.getByText("Write the docs")).toBeVisible();
  await page.getByRole("button", { name: "Forward" }).click();
  await expect(pane.getByRole("tab", { name: "Details" })).toBeVisible();
  // Close retires the visit: Back does not stop on the card again.
  await pane.getByRole("button", { name: "Close card" }).click();
  await expect(pane.getByRole("tab", { name: "Details" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Forward" })).toBeDisabled();
});

test("a person who can only read sees the board without a way to add cards", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.beehiveFixture = { role: "read" };
  });
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByText("No cards yet")).toBeVisible();
  await expect(pane.getByRole("button", { name: "New card" })).toHaveCount(0);
});

test("a card another person adds shows up on the open board without a new read", async ({
  page,
}) => {
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByText("No cards yet")).toBeVisible();
  const before = await page.evaluate(() => window.beehiveFixture.calls.length);
  // Another person's write goes straight to the engine, not through this page.
  await page.evaluate(() =>
    window.beehiveFixture.externalCreate("Added elsewhere"),
  );
  await expect(pane.getByText("Added elsewhere")).toBeVisible();
  const calls = await page.evaluate(() => window.beehiveFixture.calls);
  expect(calls.slice(before).some((c) => c.includes("ListCards"))).toBe(false);
});
