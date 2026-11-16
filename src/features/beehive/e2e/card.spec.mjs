// The kiln `card` spec, ported to the part of a card Phase 4 serves: a person
// adds a card, opens it and reads its details, and a card added elsewhere
// reaches an open board. Live, History, Usage and the stage controls return in
// the phases that add runs and stages (see PORTING.md in the Buzz checkout).
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

test("a person adds a card with a description and reads it back on the card", async ({
  page,
}) => {
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("button", { name: "New card" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New card" });
  await dialog.getByLabel("Title").fill("Write the release notes");
  await dialog
    .getByLabel(/Description/)
    .fill("Cover the new board.\nMention archive.");
  await dialog.getByRole("button", { name: "Add card" }).click();

  const backlog = pane.getByRole("region", { name: "Backlog" });
  await expect(backlog.getByText("Write the release notes")).toBeVisible();
  await backlog
    .getByRole("button", { name: "Write the release notes", exact: true })
    .click();
  await expect(pane.getByRole("tab", { name: "Details" })).toBeVisible();
  await expect(pane.getByText("Cover the new board.")).toBeVisible();
  await expect(pane.getByText("Mention archive.")).toBeVisible();
});

test("a card added by another session shows on an open board within two seconds", async ({
  browser,
}) => {
  const watcher = await (await browser.newContext()).newPage();
  const writer = await (await browser.newContext()).newPage();
  try {
    await watcher.goto(world.pageUrl);
    await writer.goto(world.pageUrl);
    const seen = watcher.getByRole("region", { name: "Beehive" });
    await expect(seen.getByRole("region", { name: "Backlog" })).toBeVisible();

    const added = writer.getByRole("region", { name: "Beehive" });
    await added.getByRole("button", { name: "New card" }).first().click();
    const dialog = writer.getByRole("dialog", { name: "New card" });
    await dialog.getByLabel("Title").fill("Seen from the other board");
    await dialog.getByRole("button", { name: "Add card" }).click();

    await expect(seen.getByText("Seen from the other board")).toBeVisible({
      timeout: 2000,
    });
  } finally {
    await watcher.context().close();
    await writer.context().close();
  }
});

test("CreateCard trims the title and keeps the description, and CreateTask reads the sentence as the title", async () => {
  const client = world.client();
  const card = await client.createCard({
    title: "  Trim me  ",
    description: "Body",
    workflow: "",
  });
  expect(card.title).toBe("Trim me");
  const read = await client.getCard(card.id);
  expect(read.body).toBe("Body");
  // The list does not carry the body: only GetCard does.
  const listed = (await client.listCards()).cards.find((c) => c.id === card.id);
  expect(listed?.body).toBe("");
  const task = await client.createTask({
    sentence: "Do the thing",
    description: "Details",
  });
  expect(task.title).toBe("Do the thing");
});

test("a card with no title is refused", async () => {
  await expect(
    world.client().createCard({ title: "   " }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

test("a note is added to a card and the engine records who wrote it", async () => {
  const client = world.client();
  const card = await client.createCard({ title: "Needs a note" });
  const reply = await client.addNote({
    cardId: card.id,
    summary: "Checked the logs",
    detail: "Nothing odd.",
  });
  expect(reply.entry?.summary).toBe("Checked the logs");
  expect(reply.entry?.author?.kind).toBe("person");
});
