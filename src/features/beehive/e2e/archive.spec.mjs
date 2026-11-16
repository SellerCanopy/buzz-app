// The kiln `archive` spec, ported as its contract: a card that is archived
// leaves the board, the archive lists it, and Restore brings it back to
// Backlog. The kiln spec drags a card onto Done; Beehive archives from the card
// (drag and drop returns with the phase that moves cards between columns).
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

test("archiving a card takes it off the board, the archive lists it, and Restore returns it to Backlog", async ({
  page,
}) => {
  const card = await world.client().createCard({ title: "Old idea" });
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  const row = pane
    .getByRole("region", { name: "Backlog" })
    .getByText("Old idea");
  await expect(row).toBeVisible();

  await row.click();
  await pane.getByRole("button", { name: "Archive" }).click();
  await expect(pane.getByRole("button", { name: "Restore" })).toBeVisible();
  await pane.getByRole("button", { name: "Close card" }).click();
  await expect(pane.getByText("Old idea")).toHaveCount(0);

  await pane.getByRole("tab", { name: "Archived" }).click();
  const archived = pane.getByRole("button", { name: /Old idea/ });
  await expect(archived).toBeVisible();
  await archived.click();
  await pane.getByRole("button", { name: "Restore" }).click();
  await expect(pane.getByRole("button", { name: "Archive" })).toBeVisible();
  await pane.getByRole("button", { name: "Close card" }).click();

  await pane.getByRole("button", { name: "Board" }).click();
  await expect(
    pane.getByRole("region", { name: "Backlog" }).getByText("Old idea"),
  ).toBeVisible();
  expect((await world.client().getCard(card.id)).archived).toBe(false);
});

test("archiving twice is harmless, and an unknown or malformed card id is refused", async () => {
  const client = world.client();
  const card = await client.createCard({ title: "Archive twice" });
  await client.archiveCards([card.id]);
  await client.archiveCards([card.id]);
  expect((await client.getCard(card.id)).archived).toBe(true);
  await expect(client.getCard("7")).rejects.toMatchObject({
    code: "invalid_argument",
  });
  await expect(
    client.archiveCards(["0b8f4d1e-6c1f-4f0e-9d53-2f3f6a0a1c11"]),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("a card archived in one session leaves another open board", async ({
  browser,
}) => {
  const card = await world.client().createCard({ title: "Leaves the board" });
  const watcher = await (await browser.newContext()).newPage();
  try {
    await watcher.goto(world.pageUrl);
    const seen = watcher.getByRole("region", { name: "Beehive" });
    await expect(seen.getByText("Leaves the board")).toBeVisible();
    await world.client().archiveCards([card.id]);
    await expect(seen.getByText("Leaves the board")).toHaveCount(0, {
      timeout: 2000,
    });
  } finally {
    await watcher.context().close();
  }
});
