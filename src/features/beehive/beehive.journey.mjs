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

test("a person who can only read has no Start run, no approvals and no Access list", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.beehiveFixture = { role: "read" };
  });
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByText("No cards yet")).toBeVisible();
  await page.evaluate(() =>
    window.beehiveFixture.externalCreate("Ship the board", "demo"),
  );
  await pane
    .getByRole("region", { name: "To do" })
    .getByRole("button", { name: /Ship the board/ })
    .click();
  await expect(pane.getByRole("tab", { name: "Details" })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Start run" })).toHaveCount(0);
  await expect(pane.getByRole("switch", { name: "Auto mode" })).toHaveCount(0);
  await pane.getByRole("button", { name: "Close card" }).click();

  await pane.getByRole("tab", { name: "Settings" }).click();
  await expect(
    pane.getByRole("combobox", { name: "Update channel" }),
  ).toBeDisabled();
  await expect(pane.getByText("Access", { exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => window.beehiveFixture.calls);
  expect(calls.some((c) => c.includes("/ListAccess"))).toBe(false);
  expect(errors.unexplained()).toEqual([]);
});

test("an admin sees who has which level in Settings, and a change saves from the row", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.beehiveFixture = { role: "admin" };
  });
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("tab", { name: "Settings" }).click();
  await expect(pane.getByText("Access", { exact: true })).toBeVisible();
  const ben = pane.getByRole("combobox", { name: "Level for Ben" });
  await expect(ben).toHaveText("Read");
  // The signed-in admin cannot lower themselves, and an agent cannot pass its owner.
  await pane.getByRole("combobox", { name: "Level for Ada" }).click();
  await expect(page.getByRole("option", { name: /Read/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await pane.getByRole("combobox", { name: "Level for builder" }).click();
  await expect(page.getByRole("option", { name: /Admin/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");

  await ben.click();
  await page.getByRole("option", { name: /Run/ }).click();
  await expect(ben).toHaveText("Run");
  // Ben is at Run now, so his agent may be raised to Run.
  await pane.getByRole("combobox", { name: "Level for builder" }).click();
  await expect(page.getByRole("option", { name: /Run/ })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(errors.unexplained()).toEqual([]);
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
  // A card with a stage thread opens on its Live tab.
  await expect(
    pane.getByRole("region", { name: "Stage thread" }),
  ).toBeVisible();
  await pane.getByRole("tab", { name: "Details" }).click();
  await expect(
    pane.getByRole("tabpanel", { name: "Details" }).getByText("Running"),
  ).toBeVisible();
  await expect(pane.getByRole("button", { name: "Start run" })).toHaveCount(0);
  expect(errors.unexplained()).toEqual([]);
});

test("a card whose next stage is held shows its steps, and Resume lets it carry on", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.beehiveFixture = { role: "admin" };
  });
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("tab", { name: "Settings" }).click();
  await pane.getByRole("combobox", { name: "Update channel" }).click();
  await page.getByRole("option", { name: "# updates" }).click();
  await pane.getByRole("tab", { name: "Board" }).click();
  const created = await page.evaluate(() =>
    window.beehiveFixture.externalCreate("Ship the board", "demo"),
  );
  await pane
    .getByRole("region", { name: "To do" })
    .getByRole("button", { name: /Ship the board/ })
    .click();
  await pane.getByRole("button", { name: "Start run" }).click();
  await pane.getByRole("tab", { name: "Steps" }).click();
  const stages = pane.getByRole("list", { name: "Stages of the run" });
  await expect(stages.getByRole("listitem")).toHaveCount(1);
  await expect(pane.getByRole("button", { name: "Resume" })).toHaveCount(0);

  // The first stage's agent reports. The workflow holds the card before approve.
  await pane.getByRole("button", { name: "Close card" }).click();
  await page.evaluate(
    (id) => window.beehiveFixture.externalPass(id),
    created.id,
  );
  await pane
    .getByRole("region", { name: "Waiting" })
    .getByRole("button", { name: /Ship the board/ })
    .click();
  await pane.getByRole("tab", { name: "Steps" }).click();
  const items = stages.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("passed, then approve");
  await expect(items.nth(1)).toContainText("Held until someone resumes it");

  // What the first stage saved: the newest version of a document, an older one on request,
  // and a file with a link to download it.
  await pane.getByRole("tab", { name: "Files" }).click();
  await expect(pane.getByRole("region", { name: "plan" })).toContainText(
    "Ship the board in two steps",
  );
  await pane.getByRole("combobox", { name: "Version" }).click();
  await page.getByRole("option", { name: "1", exact: true }).click();
  await expect(pane.getByRole("region", { name: "plan" })).toContainText(
    "Draft one",
  );
  await pane.getByRole("combobox", { name: "File" }).click();
  await page.getByRole("option", { name: "sketch" }).click();
  await expect(pane.getByText("image/png · 2 KB")).toBeVisible();
  await expect(pane.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    "https://relay.example.org/media/sketch.png",
  );

  await pane.getByRole("button", { name: "Resume" }).click();
  await pane.getByRole("tab", { name: "Details" }).click();
  await expect(
    pane.getByRole("tabpanel", { name: "Details" }).getByText("Running"),
  ).toBeVisible();
  await expect(pane.getByRole("button", { name: "Resume" })).toHaveCount(0);
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

/** An admin's card whose first stage reported, so it holds two stage threads. */
async function cardWithTwoThreads(page, title = "Ship the board") {
  await page.addInitScript(() => {
    window.beehiveFixture = { role: "admin" };
  });
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("tab", { name: "Settings" }).click();
  await pane.getByRole("combobox", { name: "Update channel" }).click();
  await page.getByRole("option", { name: "# updates" }).click();
  await pane.getByRole("tab", { name: "Board" }).click();
  const created = await page.evaluate(
    (name) => window.beehiveFixture.externalCreate(name, "demo"),
    title,
  );
  await pane
    .getByRole("region", { name: "To do" })
    .getByRole("button", { name: title })
    .click();
  await pane.getByRole("button", { name: "Start run" }).click();
  await pane.getByRole("button", { name: "Close card" }).click();
  await page.evaluate(
    (id) => window.beehiveFixture.externalPass(id),
    created.id,
  );
  await pane
    .getByRole("region", { name: "Waiting" })
    .getByRole("button", { name: title })
    .click();
  return pane;
}

test("the Live tab shows the current stage's thread and the picker reaches the earlier one", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  const pane = await cardWithTwoThreads(page);
  const tabs = pane.getByRole("tab");
  await expect(tabs).toHaveText([
    "Live",
    "Steps",
    "Files",
    "Activity",
    "Details",
  ]);
  const thread = pane.getByRole("region", { name: "Stage thread" });
  await expect(thread).toContainText("Thread in #updates");
  const current = await thread.getAttribute("data-root");

  // One entry per stage, the current one marked.
  const picker = pane.getByRole("combobox", { name: "Stage" });
  await expect(picker).toHaveText("approve");
  await picker.click();
  await expect(page.getByRole("option")).toHaveText([
    /^plan/,
    /^approve\s*Current/,
  ]);
  await page.getByRole("option", { name: /^plan/ }).click();
  await expect(picker).toHaveText("plan");
  await expect(thread).not.toHaveAttribute("data-root", current);
  expect(errors.unexplained()).toEqual([]);
});

test("a tab is a visit: Back returns to the tab a person left", async ({
  page,
}) => {
  const pane = await cardWithTwoThreads(page);
  const selected = (name) =>
    expect(pane.getByRole("tab", { name })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  await selected("Live");
  await pane.getByRole("tab", { name: "Steps" }).click();
  await selected("Steps");
  await pane.getByRole("tab", { name: "Files" }).click();
  await selected("Files");
  await page.getByRole("button", { name: "Back" }).click();
  await selected("Steps");
  await page.getByRole("button", { name: "Back" }).click();
  await selected("Live");
  await page.getByRole("button", { name: "Forward" }).click();
  await selected("Steps");
  // Close retires the card's tab visits along with the card.
  await pane.getByRole("button", { name: "Close card" }).click();
  await expect(pane.getByRole("tab", { name: "Steps" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Forward" })).toBeDisabled();
});

test("the Live tab stays inside a narrow window in dark appearance with large text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 800 });
  const longTitle =
    "Rework the whole intake pipeline so every attachment is scanned before it reaches review";
  const pane = await cardWithTwoThreads(page, longTitle);
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
  });
  const inside = async (locator) => {
    const box = await locator.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(420);
    return box;
  };
  const title = pane.getByRole("heading", { name: longTitle });
  const titleBox = await inside(title);
  const close = await inside(pane.getByRole("button", { name: "Close card" }));
  // The actions wrap below the title rather than over it.
  const overlaps =
    titleBox.x < close.x + close.width &&
    close.x < titleBox.x + titleBox.width &&
    titleBox.y < close.y + close.height &&
    close.y < titleBox.y + titleBox.height;
  expect(overlaps).toBe(false);
  await inside(pane.getByRole("combobox", { name: "Stage" }));
  await inside(pane.getByRole("region", { name: "Stage thread" }));
});

async function openNeedsYou(page, role) {
  if (role)
    await page.addInitScript((r) => {
      window.beehiveFixture = { role: r };
    }, role);
  await page.goto(url);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByText("No cards yet")).toBeVisible();
  return pane;
}

test("an approval that opens shows on the Needs you tab without a new read, and Reject sends the reason", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  const pane = await openNeedsYou(page);
  const tab = pane.getByRole("tab", { name: /Needs you/ });
  await expect(tab).not.toContainText("1");

  await page.evaluate(() =>
    window.beehiveFixture.externalGate("Ship the board"),
  );
  // The badge follows the event log; nothing re-read the board to learn of it.
  await expect(tab).toContainText("1");
  await tab.click();
  const gates = pane.getByRole("list", { name: "Needs you" });
  const gate = gates.getByRole("region", { name: /Approval: Ship the board/ });
  await expect(gate).toContainText("Approve the plan");
  await expect(gate).toContainText("To approve: plan");

  // Reject asks for words first, and its button stays off until there are some.
  await gate.getByRole("button", { name: "Reject" }).click();
  const dialog = page.getByRole("dialog", { name: "Reject" });
  const submit = dialog.getByRole("button", { name: "Reject" });
  await expect(submit).toBeDisabled();
  const reason = dialog.getByLabel("Reason");
  await expect(reason).toBeFocused();
  await reason.fill("Add a rollback step.");
  await submit.click();
  await expect(dialog).toHaveCount(0);

  await expect(pane.getByText("Nothing needs you")).toBeVisible();
  await expect(tab).not.toContainText("1");

  // The answer is on the card's Activity tab with who gave it and why.
  await pane.getByRole("tab", { name: "Board" }).click();
  await pane.getByRole("button", { name: /Ship the board/ }).click();
  await pane.getByRole("tab", { name: "Activity" }).click();
  const entry = pane
    .getByRole("list", { name: "Activity" })
    .getByRole("listitem")
    .first();
  await expect(entry).toContainText("Rejected the plan");
  await expect(entry).toContainText("Add a rollback step.");
  await expect(entry).toContainText("Person npub");
  expect(errors.unexplained()).toEqual([]);
});

test("Approve answers at once, and Reject is not a history entry", async ({
  page,
}) => {
  const pane = await openNeedsYou(page);
  await page.evaluate(() =>
    window.beehiveFixture.externalGate("Cut the release"),
  );
  await pane.getByRole("tab", { name: /Needs you/ }).click();
  const gate = pane.getByRole("region", { name: /Approval: Cut the release/ });

  // Opening and cancelling the dialog leaves the history where it was.
  await gate.getByRole("button", { name: "Reject" }).click();
  await page
    .getByRole("dialog", { name: "Reject" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();

  await gate.getByRole("button", { name: "Approve" }).click();
  await expect(pane.getByText("Nothing needs you")).toBeVisible();
});

test("a person who can only read sees what needs people but cannot answer", async ({
  page,
}) => {
  const pane = await openNeedsYou(page, "read");
  await page.evaluate(() => window.beehiveFixture.externalGate("Read only"));
  await pane.getByRole("tab", { name: /Needs you/ }).click();
  const gate = pane.getByRole("region", { name: /Approval: Read only/ });
  await expect(gate.getByRole("button", { name: "Open card" })).toBeVisible();
  await expect(gate.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(gate.getByRole("button", { name: "Reject" })).toHaveCount(0);
});

test("Needs you shows its empty state before anything waits", async ({
  page,
}) => {
  const pane = await openNeedsYou(page);
  await pane.getByRole("tab", { name: /Needs you/ }).click();
  await expect(pane.getByText("Nothing needs you")).toBeVisible();
});

test("the Usage view shows runs and what agents started, with no token or cost figure", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  const pane = await openNeedsYou(page);
  await pane.getByRole("tab", { name: "Usage" }).click();
  const runs = pane.getByRole("region", { name: "Runs" });
  await expect(runs).toContainText("1m 15s");
  await expect(runs).toContainText("1h 1m");
  const table = pane.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("row").last()).toContainText("Nov 9");
  const text = (await pane.innerText()).toLowerCase();
  expect(text).not.toMatch(/token|cost|dollar|price|\$/);
  expect(errors.unexplained()).toEqual([]);
});

test("Needs you and Usage stay inside a narrow window in dark appearance with large text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 800 });
  const pane = await openNeedsYou(page);
  await page.evaluate(() =>
    window.beehiveFixture.externalGate(
      "Rework the whole intake pipeline so every attachment is scanned before it reaches review",
    ),
  );
  await page.getByRole("button", { name: "Toggle appearance" }).click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
  });
  const inside = async (locator) => {
    const box = await locator.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(420);
  };
  await pane.getByRole("tab", { name: /Needs you/ }).click();
  const gate = pane.getByRole("region", { name: /Approval:/ });
  await inside(gate);
  await inside(gate.getByRole("button", { name: "Approve" }));
  await inside(gate.getByRole("button", { name: "Reject" }));
  await gate.getByRole("button", { name: "Reject" }).click();
  await inside(page.getByRole("dialog", { name: "Reject" }));
  await page
    .getByRole("dialog", { name: "Reject" })
    .getByRole("button", { name: "Cancel" })
    .click();

  await pane.getByRole("tab", { name: "Usage" }).click();
  await inside(pane.getByRole("table"));
  await inside(pane.getByRole("region", { name: "Runs" }));
});
