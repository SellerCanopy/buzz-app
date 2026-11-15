import { afterEach, expect, it } from "vitest";
import { EngineError } from "./transport";
import { provideWebSigner, webAuthorization } from "./web-signer";

afterEach(() => provideWebSigner(undefined));

it("refuses to sign in without a signer", async () => {
  await expect(
    webAuthorization("https://hive.example.org"),
  ).rejects.toMatchObject({
    code: "unauthenticated",
  });
  await expect(
    webAuthorization("https://hive.example.org"),
  ).rejects.toBeInstanceOf(EngineError);
});

it("asks the signer for a NIP-98 event for the token URL", async () => {
  let seen: unknown;
  provideWebSigner(async (template) => {
    seen = template;
    return { ...template, id: "i", pubkey: "p", sig: "s" };
  });
  const header = await webAuthorization(
    "https://hive.example.org",
    () => 5_000,
  );
  expect(seen).toMatchObject({
    kind: 27235,
    created_at: 5,
    content: "",
    tags: expect.arrayContaining([
      ["u", "https://hive.example.org/auth/token"],
      ["method", "POST"],
    ]),
  });
  const tags = (seen as { tags: string[][] }).tags;
  expect(tags.find((t) => t[0] === "nonce")?.[1]).toBeTruthy();
  expect(header.startsWith("Nostr ")).toBe(true);
  expect(JSON.parse(atob(header.slice(6)))).toMatchObject({
    id: "i",
    kind: 27235,
  });
});
