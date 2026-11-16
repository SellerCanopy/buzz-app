// The kiln `board` spec, ported to the part of the board served so far: a
// signed-in person opens the board of a real `buzz-hive`, and a member who can
// only read has no way to add a card. The drag, move and label tests wait for
// the phases that add stages and intake (see crates/buzz-hive-core/PORTING.md
// in the Buzz checkout).
import { expect, test } from "../../../../tests/browser/playwright-test.mjs";
import { createClient } from "../engine/client.ts";
import { createSession } from "../engine/session.ts";
import { TOKEN_PATH, webCarrier } from "../engine/transport.ts";
import { signAuthorization } from "../engine/web-signer.ts";
import { hiveUnavailable } from "./engine.mjs";
import { testPubkey, testSigner } from "./signer.ts";
import { startWorld } from "./world.mjs";

test.skip(!!hiveUnavailable(), hiveUnavailable() ?? "");
test.describe.configure({ mode: "serial" });

let world;
let hive;

test.beforeAll(async () => {
  world = await startWorld();
  hive = world.hive;
});
test.afterAll(async () => {
  await world?.stop();
});

// The same client the app uses, with the web carrier and the test signer.
function nodeClient() {
  return createClient(
    createSession(
      webCarrier(hive.url, () => signAuthorization(hive.url, testSigner)),
    ),
  );
}

test("the board of a real engine is empty for a member", async () => {
  const client = nodeClient();
  const cards = await client.listCards();
  expect(cards.cards).toEqual([]);
  const me = await client.whoAmI();
  expect(me.me?.userId).toBe(testPubkey);
  expect(me.role).toBe("read");
  expect(me.kind).toBe("person");
  const status = await client.getStatus();
  expect(status.communityId).toBe(me.companyId);
});

test("a call without a token is unauthenticated", async () => {
  const res = await fetch(
    `${hive.url}/kiln.engine.v1.EngineService/ListCards`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  expect(res.status).toBe(401);
  expect((await res.json()).code).toBe("unauthenticated");
});

test("a signed event can be used for one token only", async () => {
  const authorization = await signAuthorization(hive.url, testSigner);
  const carrier = webCarrier(hive.url, async () => authorization);
  await carrier.post(TOKEN_PATH, {}, { authorization });
  await expect(
    carrier.post(TOKEN_PATH, {}, { authorization }),
  ).rejects.toMatchObject({ code: "unauthenticated" });
});

test("the page signs in with the test key and shows the empty board", async ({
  page,
}) => {
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByRole("region", { name: "Backlog" })).toBeVisible();
  await expect(pane.getByRole("alert")).toHaveCount(0);
});

test("the page keeps working after the engine restarts", async ({ page }) => {
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByRole("region", { name: "Backlog" })).toBeVisible();
  await hive.restart();
  await page.reload();
  await expect(pane.getByRole("region", { name: "Backlog" })).toBeVisible();
});

test("a member who can only read cannot add a card, in the page or in the engine", async ({
  page,
}) => {
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByRole("region", { name: "Backlog" })).toBeVisible();
  await expect(pane.getByRole("button", { name: "New card" })).toHaveCount(0);
  await expect(
    nodeClient().createCard({ title: "Not allowed" }),
  ).rejects.toMatchObject({ code: "permission_denied" });
});
