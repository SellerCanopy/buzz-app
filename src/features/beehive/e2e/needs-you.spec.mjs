// The Needs you, Usage and Activity parts of Beehive against a real `buzz-hive`. A gate that
// an agent opens needs a relay and a running agent, so the engine's own relay test
// (`e2e_approval` in the Buzz checkout) covers answering one end to end. What this spec
// covers is what a person sees and what the engine refuses when nothing waits.
import { expect, test } from "../../../../tests/browser/playwright-test.mjs";
import { hiveUnavailable } from "./engine.mjs";
import { startWorld } from "./world.mjs";

test.skip(!!hiveUnavailable(), hiveUnavailable() ?? "");
test.describe.configure({ mode: "serial" });

let world;
test.beforeAll(async () => {
  world = await startWorld({ role: "admin" });
});
test.afterAll(async () => {
  await world?.stop();
});

test("with nothing waiting, Needs you says so and its tab shows no count", async ({
  page,
}) => {
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  const tab = pane.getByRole("button", { name: /Needs you/ });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(pane.getByText("Nothing needs you")).toBeVisible();
  await expect(tab).not.toContainText(/\d/);
});

test("Usage reads the engine and shows no token or cost figure", async ({
  page,
}) => {
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("button", { name: "Usage" }).click();
  await expect(pane.getByText("No activity yet")).toBeVisible();
  await expect(pane.getByRole("alert")).toHaveCount(0);
  const text = (await pane.innerText()).toLowerCase();
  expect(text).not.toMatch(/token|cost|dollar|price|\$/);
});

test("a note shows on the card's Activity tab with who wrote it", async ({
  page,
}) => {
  const card = await world.client().createCard({ title: "Needs a note" });
  await world.client().addNote({
    cardId: card.id,
    summary: "Checked the logs",
    detail: "Nothing odd.",
  });
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("button", { name: "Needs a note", exact: true }).click();
  await pane.getByRole("tab", { name: "Activity" }).click();
  const entry = pane
    .getByRole("list", { name: "Activity" })
    .getByRole("listitem")
    .first();
  await expect(entry).toContainText("Checked the logs");
  await expect(entry).toContainText("Nothing odd.");
  await expect(entry).toContainText("Person npub");
});

test("the engine lists no open items and counts no usage before anything has run", async () => {
  const client = world.client();
  const inbox = await client.listInbox();
  expect(inbox.items).toHaveLength(0);
  const usage = await client.getUsage();
  expect(usage.runs).toBe(0);
  expect(usage.weeks).toHaveLength(8);
});
