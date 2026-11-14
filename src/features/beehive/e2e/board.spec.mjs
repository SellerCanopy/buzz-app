// The kiln `board` spec, ported to the part of the board Phase 3 serves: a
// signed-in person opens the board of a real `buzz-hive` and it is empty.
// The drag, move and label tests wait for the phases that add cards and
// stages (see crates/buzz-hive-core/PORTING.md in the Buzz checkout).
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../../../tests/browser/playwright-test.mjs";
import { createServer } from "../../../../tests/browser/vite-server.mjs";
import { createClient } from "../engine/client.ts";
import { createSession } from "../engine/session.ts";
import { webCarrier } from "../engine/transport.ts";
import { provideWebSigner, webAuthorization } from "../engine/web-signer.ts";
import { hiveUnavailable, startHive } from "./engine.mjs";
import { testPubkey, testSigner } from "./signer.ts";

test.skip(!!hiveUnavailable(), hiveUnavailable() ?? "");
test.describe.configure({ mode: "serial" });

let vite;
let fixtureUrl;
let hive;

test.beforeAll(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../../../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  fixtureUrl = `${origin}/src/features/beehive/fixture.html`;
  hive = await startHive({ allowedOrigins: [origin], member: testPubkey });
});
test.afterAll(async () => {
  await hive?.stop();
  await vite?.close();
});

// The same client the app uses, with the web carrier and the test signer.
function nodeClient() {
  provideWebSigner(testSigner);
  return createClient(
    createSession(webCarrier(hive.url, () => webAuthorization(hive.url))),
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
  provideWebSigner(testSigner);
  const authorization = await webAuthorization(hive.url);
  const carrier = webCarrier(hive.url, async () => authorization);
  await carrier.post("/auth/token", {}, { authorization });
  await expect(
    carrier.post("/auth/token", {}, { authorization }),
  ).rejects.toMatchObject({ code: "unauthenticated" });
});

test("the page signs in with the test key and shows the empty board", async ({
  page,
}) => {
  await page.goto(`${fixtureUrl}?hive=${encodeURIComponent(hive.url)}`);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByText("No cards yet")).toBeVisible();
  await expect(pane.getByRole("alert")).toHaveCount(0);
});

test("the page keeps working after the engine restarts", async ({ page }) => {
  await page.goto(`${fixtureUrl}?hive=${encodeURIComponent(hive.url)}`);
  const pane = page.getByRole("region", { name: "Beehive" });
  await expect(pane.getByText("No cards yet")).toBeVisible();
  await hive.restart();
  await page.reload();
  await expect(pane.getByText("No cards yet")).toBeVisible();
});
