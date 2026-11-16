import { expect, it, vi } from "vitest";
import { createClient } from "./client";
import type { Session } from "./session";

const SERVICE = "/kiln.engine.v1.EngineService/";

/** A session that records each call and answers with `reply`. */
function wire(reply: unknown = {}) {
  const call = vi.fn(
    async (_path: string, _body: unknown, _signal?: AbortSignal) => reply,
  );
  const client = createClient({ call } as unknown as Session);
  /** The path and request body of the nth call. */
  const sent = (n = 0) => {
    const [path, body] = call.mock.calls[n] ?? [];
    return { path, body };
  };
  return { client, call, sent };
}

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

it("sends each file of a draft as its UTF-8 bytes, with the hash it was opened at", async () => {
  const { client, sent } = wire({ hash: "h2" });
  await client.saveWorkflow(
    {
      name: "rpi",
      files: { "workflow.yaml": "name: é\n", "kiln-package.yaml": "v: 1" },
    },
    "h1",
  );
  expect(sent()).toEqual({
    path: `${SERVICE}SaveWorkflow`,
    body: {
      draft: {
        name: "rpi",
        files: {
          "workflow.yaml": base64("name: é\n"),
          "kiln-package.yaml": base64("v: 1"),
        },
      },
      baseHash: "h1",
    },
  });
});

it("sends a draft to be checked without a base hash", async () => {
  const { client, sent } = wire({});
  await client.checkDraft({ name: "rpi", files: { "workflow.yaml": "x" } });
  expect(sent()).toEqual({
    path: `${SERVICE}CheckWorkflow`,
    body: {
      draft: { name: "rpi", files: { "workflow.yaml": base64("x") } },
    },
  });
});

it("copies and imports a package by name", async () => {
  const { client, sent } = wire({ name: "copy" });
  await client.duplicateWorkflow("rpi", "copy");
  expect(sent(0)).toEqual({
    path: `${SERVICE}DuplicateWorkflow`,
    body: { name: "rpi", newName: "copy" },
  });
  await client.importWorkflow(new Uint8Array([1, 2, 3]), "imported");
  expect(sent(1)).toEqual({
    path: `${SERVICE}ImportWorkflow`,
    body: { zip: "AQID", name: "imported" },
  });
});

it("asks for the files of a package as text", async () => {
  const { client, sent } = wire({ hash: "h1", textFiles: { a: "b" } });
  const opened = await client.getWorkflowDraft("rpi");
  expect(sent()).toEqual({
    path: `${SERVICE}GetWorkflowDraft`,
    body: { name: "rpi", text: true },
  });
  expect(opened.textFiles).toEqual({ a: "b" });
});

it("names github.com as the host of a card made from an issue, and leaves a hand-written card without one", async () => {
  const { client, sent } = wire({});
  await client.createCard({
    title: "Fix it",
    issue: { owner: "example-org", repo: "api", number: 42 },
  });
  expect(sent(0).body).toEqual({
    title: "Fix it",
    issue: {
      host: "github.com",
      owner: "example-org",
      repo: "api",
      number: 42,
    },
  });
  await client.createCard({ title: "By hand" });
  expect(sent(1).body).toEqual({ title: "By hand" });
});

it("searches open issues unless told otherwise", async () => {
  const { client, sent } = wire({});
  await client.searchIssues({ repos: ["example-org/api"] });
  expect(sent(0)).toEqual({
    path: `${SERVICE}SearchIssues`,
    body: {
      host: "github.com",
      filter: { repos: ["example-org/api"], state: "open" },
    },
  });
  await client.searchIssues({
    repos: ["example-org/api"],
    text: "crash",
    state: "closed",
  });
  expect(sent(1).body).toEqual({
    host: "github.com",
    filter: { repos: ["example-org/api"], text: "crash", state: "closed" },
  });
});

it("reads and writes settings in the user scope", async () => {
  const { client, sent } = wire({});
  await client.getCommunitySettings();
  expect(sent(0)).toEqual({
    path: `${SERVICE}GetSettings`,
    body: { scope: "user" },
  });
  await client.setCommunitySetting("update_channel", '"abc"');
  expect(sent(1)).toEqual({
    path: `${SERVICE}SetSetting`,
    body: { scope: "user", key: "update_channel", valueJson: '"abc"' },
  });
});

it("starts a chat in a thread and settles a proposal", async () => {
  const { client, sent } = wire({ jobId: "job-1" });
  const started = await client.startChat("Hello", "root-1");
  expect(sent(0)).toEqual({
    path: `${SERVICE}StartChat`,
    body: { text: "Hello", rootEventId: "root-1" },
  });
  expect(started.jobId).toBe("job-1");
  await client.startChat("New thread");
  expect(sent(1).body).toEqual({ text: "New thread" });

  await client.resolveProposal(5n, true);
  expect(sent(2)).toEqual({
    path: `${SERVICE}ResolveProposal`,
    body: { proposalId: "5", accepted: true },
  });
});

it("ignores a field of the reply that this app does not know, as an older app meets a newer engine", async () => {
  const { client } = wire({ headSeq: "12", addedByANewerEngine: { x: 1 } });
  const status = await client.getStatus();
  expect(status.headSeq).toBe(12n);
});

it("passes the abort signal to the session", async () => {
  const { client, call } = wire({});
  const abort = new AbortController();
  await client.getStatus(abort.signal);
  expect(call.mock.calls[0]?.[2]).toBe(abort.signal);
});
