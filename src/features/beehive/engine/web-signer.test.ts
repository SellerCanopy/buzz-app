import { expect, it } from "vitest";
import { signAuthorization } from "./web-signer";

it("asks the signer for a NIP-98 event for the token URL", async () => {
  let seen: unknown;
  const header = await signAuthorization(
    "https://hive.example.org",
    async (template) => {
      seen = template;
      return { ...template, id: "i", pubkey: "p", sig: "s" };
    },
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

it("signs for two signers at once without one leaking into the other", async () => {
  const origin = "https://hive.example.org";
  const as = (pubkey: string) => async (template: object) => ({
    ...template,
    pubkey,
  });
  const [a, b] = await Promise.all([
    signAuthorization(origin, as("a")),
    signAuthorization(origin, as("b")),
  ]);
  expect(JSON.parse(atob(a.slice(6))).pubkey).toBe("a");
  expect(JSON.parse(atob(b.slice(6))).pubkey).toBe("b");
});
