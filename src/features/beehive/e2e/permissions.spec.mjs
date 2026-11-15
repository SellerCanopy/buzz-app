// The kiln `permissions` spec, ported to Beehive levels: an admin sets a second person's
// level, the engine then allows and refuses calls to match, and Settings lists the same
// levels. The first person is a relay owner, so acts at Admin; the second starts at Read.
import { expect, test } from "../../../../tests/browser/playwright-test.mjs";
import { hiveUnavailable } from "./engine.mjs";
import { otherPubkey, otherSigner } from "./signer.ts";
import { startWorld } from "./world.mjs";

test.skip(!!hiveUnavailable(), hiveUnavailable() ?? "");
test.describe.configure({ mode: "serial" });

let world;
let admin;
let other;
test.beforeAll(async () => {
  world = await startWorld({
    role: "owner",
    others: [{ pubkey: otherPubkey, role: "member" }],
  });
  admin = world.client();
  other = world.clientFor(otherSigner);
});
test.afterAll(async () => {
  await world?.stop();
});

const refused = (call) =>
  expect(call).rejects.toMatchObject({ code: "permission_denied" });

test("a new member can read and nothing more", async () => {
  expect((await other.whoAmI()).role).toBe("read");
  expect((await other.listCards()).cards).toEqual([]);
  await refused(other.createCard({ title: "Not allowed" }));
  await refused(other.setAccessLevel(otherPubkey, "admin"));
});

test("an admin sets the level and the engine follows it at once", async () => {
  const set = await admin.setAccessLevel(otherPubkey, "run");
  expect(set.level).toBe("run");
  expect((await other.whoAmI()).role).toBe("run");
  const card = await other.createCard({ title: "Now allowed" });
  expect(card.title).toBe("Now allowed");
  // Run still cannot set levels.
  await refused(other.setAccessLevel(otherPubkey, "admin"));

  await admin.setAccessLevel(otherPubkey, "read");
  expect((await other.whoAmI()).role).toBe("read");
  await refused(other.createCard({ title: "Not any more" }));
});

test("each change is in the event log with who made it", async () => {
  const polled = await admin.pollEvents(0n, 0);
  const changes = polled.events.filter((e) => e.type === "access.changed");
  expect(changes.length).toBeGreaterThanOrEqual(2);
  expect(JSON.parse(changes[0].payloadJson)).toMatchObject({
    pubkey: otherPubkey,
    level: "run",
    previous: "read",
  });
});

test("an admin cannot lower their own level, and a bad request is refused", async () => {
  const me = (await admin.whoAmI()).me.userId;
  await expect(admin.setAccessLevel(me, "read")).rejects.toMatchObject({
    code: "failed_precondition",
  });
  await expect(
    admin.setAccessLevel(otherPubkey, "owner"),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("a person at None cannot read the board, and Settings lists both people", async ({
  page,
}) => {
  await admin.setAccessLevel(otherPubkey, "none");
  expect((await other.whoAmI()).role).toBe("none");
  await refused(other.listCards());

  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("tab", { name: "Settings" }).click();
  const short = `${otherPubkey.slice(0, 8)}…`;
  const row = pane.getByRole("combobox", { name: `Level for ${short}` });
  await expect(row).toHaveText("None");
  await row.click();
  await page.getByRole("option", { name: /Read/ }).click();
  await expect(row).toHaveText("Read");
  expect((await other.whoAmI()).role).toBe("read");
});
