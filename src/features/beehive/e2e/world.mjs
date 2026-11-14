// What every real-engine spec needs: the fixture page on a Vite server, a real
// `buzz-hive` that allows its origin, and the same client the app uses, signed
// with the test key.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createServer } from "../../../../tests/browser/vite-server.mjs";
import { createClient } from "../engine/client.ts";
import { createSession } from "../engine/session.ts";
import { webCarrier } from "../engine/transport.ts";
import { provideWebSigner, webAuthorization } from "../engine/web-signer.ts";
import { startHive } from "./engine.mjs";
import { testPubkey, testSigner } from "./signer.ts";

/** @param {{ role?: "owner"|"admin"|"member" }} [options] the test key's relay role */
export async function startWorld({ role = "member" } = {}) {
  const vite = await createServer({
    root: fileURLToPath(new URL("../../../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const hive = await startHive({
    allowedOrigins: [origin],
    member: testPubkey,
    role,
  });
  return {
    hive,
    /** The page, signed in against this engine. */
    pageUrl: `${origin}/src/features/beehive/fixture.html?hive=${encodeURIComponent(hive.url)}`,
    /** A client for the test key, to set up or change cards outside the page. */
    client() {
      provideWebSigner(testSigner);
      return createClient(
        createSession(webCarrier(hive.url, () => webAuthorization(hive.url))),
      );
    },
    async stop() {
      await hive.stop();
      await vite.close();
    },
  };
}
