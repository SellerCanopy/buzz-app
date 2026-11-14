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

async function openWorkflows(page) {
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("tab", { name: "Workflows" }).click();
  return pane;
}

test("the Workflows view lists the built-in packages with their stages", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  const pane = await openWorkflows(page);
  const demo = pane.getByRole("region", { name: "demo" });
  await expect(
    demo.getByText("A small workflow for trying Beehive."),
  ).toBeVisible();
  await expect(demo.getByText("Ready")).toBeVisible();
  const stages = demo.getByRole("list", { name: "Stages of demo" });
  await expect(stages.getByRole("listitem")).toHaveCount(2);
  await expect(stages.getByRole("listitem").first()).toContainText(
    "Prompt, agent builder",
  );
  const calls = await page.evaluate(() => window.beehiveFixture.calls);
  expect(calls.some((c) => c.includes("/ListWorkflows bearer"))).toBe(true);
  expect(errors.unexplained()).toEqual([]);
});

test("a broken package shows its finding with the code, and a folder that did not load shows its own", async ({
  page,
}) => {
  const pane = await openWorkflows(page);
  const broken = pane.getByRole("region", { name: "broken" });
  await expect(broken.getByText("Has errors")).toBeVisible();
  const finding = broken
    .getByRole("list", { name: "Findings for broken" })
    .getByRole("listitem");
  await expect(finding).toContainText("Error");
  await expect(finding).toContainText("route_target_unknown");
  await expect(finding).toContainText("a stage that does not exist");
  const unloaded = pane.getByRole("region", {
    name: "Packages that did not load",
  });
  await expect(unloaded.getByText("workflows/nameless")).toBeVisible();
  await expect(unloaded).toContainText("package_unreadable");
});

test("the Workflows view keeps the board's cards and comes back to them", async ({
  page,
}) => {
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await addCard(pane, "Stay on the board");
  await pane.getByRole("tab", { name: "Workflows" }).click();
  await expect(pane.getByRole("region", { name: "demo" })).toBeVisible();
  await expect(pane.getByText("Stay on the board")).toHaveCount(0);
  await pane.getByRole("tab", { name: "Board" }).click();
  await expect(pane.getByText("Stay on the board")).toBeVisible();
});

test("the Workflows view stays inside a narrow window in dark appearance with large text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(url);
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
  });
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("tab", { name: "Workflows" }).click();
  const finding = pane
    .getByRole("list", { name: "Findings for broken" })
    .getByRole("listitem");
  await expect(finding).toBeVisible();
  const box = await finding.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(420);
});

test("an admin sets the update channel, then starts a run on a card with a workflow", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.beehiveFixture = { role: "admin" };
  });
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByText("No cards yet")).toBeVisible();
  await page.evaluate(() =>
    window.beehiveFixture.externalCreate("Ship the board", "demo"),
  );
  const todo = pane.getByRole("region", { name: "To do" });
  await todo.getByRole("button", { name: /Ship the board/ }).click();

  // With no update channel the engine refuses, and the page shows its words.
  await pane.getByRole("button", { name: "Start run" }).click();
  await expect(pane.getByRole("alert")).toHaveText(
    "choose an update channel in Beehive settings before starting a run",
  );
  await pane.getByRole("button", { name: "Close card" }).click();

  await pane.getByRole("tab", { name: "Settings" }).click();
  const channel = pane.getByRole("combobox", { name: "Update channel" });
  await expect(channel).toHaveText("No channel");
  // A channel the Beehive account has not joined is refused and the choice stays.
  await channel.click();
  await page.getByRole("option", { name: "# empty-room" }).click();
  await expect(pane.getByRole("alert")).toHaveText(
    "add the Beehive account to this channel, then save again",
  );
  await expect(channel).toHaveText("No channel");
  await channel.click();
  await page.getByRole("option", { name: "# updates" }).click();
  await expect(channel).toHaveText("# updates");
  await expect(pane.getByRole("alert")).toHaveCount(0);

  await pane.getByRole("tab", { name: "Board" }).click();
  await todo.getByRole("button", { name: /Ship the board/ }).click();
  await pane.getByRole("button", { name: "Start run" }).click();
  await expect(
    pane.getByRole("tabpanel", { name: "Details" }).getByText("Running"),
  ).toBeVisible();
  await expect(pane.getByRole("button", { name: "Start run" })).toHaveCount(0);
  expect(errors.unexplained()).toEqual([]);
});

test("a person who can run but is not an admin sees the update channel and cannot change it", async ({
  page,
}) => {
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("tab", { name: "Settings" }).click();
  await expect(
    pane.getByRole("combobox", { name: "Update channel" }),
  ).toBeDisabled();
});

test("Settings stays inside a narrow window in dark appearance with large text", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.beehiveFixture = { role: "admin" };
  });
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(url);
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
  });
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("tab", { name: "Settings" }).click();
  const channel = pane.getByRole("combobox", { name: "Update channel" });
  await expect(channel).toBeVisible();
  const box = await channel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(420);
});
