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
  expect(calls).toEqual([
    "/auth/token Nostr fixture",
    "/kiln.engine.v1.EngineService/ListCards bearer fixture-token",
  ]);
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
