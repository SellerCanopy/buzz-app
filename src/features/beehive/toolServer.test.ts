import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { AgentToolServerSchema } from "./gen/kiln/engine/v1/engine_pb";
import {
  check,
  describe,
  formOf,
  joinCommand,
  keptNote,
  SECRET_MESSAGE,
  specFor,
  splitCommand,
  type ToolServerForm,
} from "./toolServer";

/** A reference to a secret by name, which a spec may hold. */
const ref = (name: string) => `\${${name}}`;

const server = (transport: string, spec: object, name = "docs") =>
  create(AgentToolServerSchema, {
    name,
    transport,
    specJson: JSON.stringify(spec),
  });

const stdio = (command: string, name = "docs"): ToolServerForm => ({
  name,
  transport: "stdio",
  command,
  url: "",
});
const http = (url: string, name = "docs"): ToolServerForm => ({
  name,
  transport: "http",
  command: "",
  url,
});

it("splits a command line into words and keeps a quoted phrase whole", () => {
  expect(splitCommand("npx docs-server --stdio")).toEqual([
    "npx",
    "docs-server",
    "--stdio",
  ]);
  expect(splitCommand(`  run  "two words" 'it''s' `)).toEqual([
    "run",
    "two words",
    "its",
  ]);
  expect(splitCommand("")).toEqual([]);
  expect(splitCommand(`say "open`)).toBeUndefined();
});

it.each([
  [["npx", "docs-server"]],
  [["run", "two words", ""]],
  [["say", `it's "quoted"`, `a"b`]],
])("writes %j so that it reads back as the same words", (parts) => {
  expect(splitCommand(joinCommand(parts))).toEqual(parts);
});

it("reads a listed server into the form and describes it", () => {
  const listed = server("stdio", {
    command: "npx",
    args: ["docs-server", "a b"],
  });
  expect(formOf(listed)).toEqual(stdio('npx docs-server "a b"'));
  expect(describe(listed)).toBe('Runs npx docs-server "a b"');
  const hosted = server("http", { url: "https://example.org/mcp" });
  expect(formOf(hosted)).toEqual(http("https://example.org/mcp"));
  expect(describe(hosted)).toBe("Hosted server at https://example.org/mcp");
});

it("reads a server whose spec is not an object as empty rather than failing", () => {
  expect(formOf(server("stdio", []))).toEqual(stdio(""));
  expect(
    formOf(create(AgentToolServerSchema, { name: "x", specJson: "{" })),
  ).toEqual(stdio("", "x"));
});

it("builds the whole spec: command and args, or url", () => {
  expect(specFor(stdio("npx docs-server --stdio"))).toEqual({
    command: "npx",
    args: ["docs-server", "--stdio"],
  });
  expect(specFor(stdio("docs"))).toEqual({ command: "docs" });
  expect(specFor(http(" https://example.org/mcp "))).toEqual({
    url: "https://example.org/mcp",
  });
});

it("carries over the env references of a saved server, and its headers, while the transport stays", () => {
  const before = server("stdio", {
    command: "npx",
    env: { LINEAR_API_KEY: ref("LINEAR_API_KEY") },
  });
  expect(specFor(stdio("npx other"), before)).toEqual({
    command: "npx",
    args: ["other"],
    env: { LINEAR_API_KEY: ref("LINEAR_API_KEY") },
  });
  expect(keptNote(before, "stdio")).toBe(
    "Keeps its environment entries: LINEAR_API_KEY.",
  );
  // Another transport has no env to keep.
  expect(specFor(http("https://example.org/mcp"), before)).toEqual({
    url: "https://example.org/mcp",
  });
  expect(keptNote(before, "http")).toBeUndefined();
  const hosted = server("http", {
    url: "https://example.org/mcp",
    headers: { Authorization: `Bearer ${ref("TOKEN")}` },
  });
  expect(specFor(http("https://example.org/b"), hosted)).toEqual({
    url: "https://example.org/b",
    headers: { Authorization: `Bearer ${ref("TOKEN")}` },
  });
  expect(keptNote(hosted, "http")).toBe("Keeps its headers: Authorization.");
});

it("needs a name that is unique for the agent, and a command for stdio", () => {
  expect(check(stdio("npx x", ""), [], true).name).toBe(
    "Enter a name for the tool server.",
  );
  expect(check(stdio("npx x", "  "), [], true).name).toBe(
    "Enter a name for the tool server.",
  );
  expect(check(stdio("npx x", "docs"), ["docs", "github"], true).name).toBe(
    "This agent already has a tool server with that name.",
  );
  expect(check(stdio("npx x", "Docs"), ["docs"], true)).toEqual({});
  expect(check(stdio("npx x", "bad name"), [], true).name).toMatch(
    /^Use letters, digits/,
  );
  expect(check(stdio("npx x", "-docs"), [], true).name).toMatch(
    /^Use letters, digits/,
  );
  expect(check(stdio("", "docs"), [], true).command).toBe(
    "Enter the command that starts the server.",
  );
  expect(check(stdio('npx "x', "docs"), [], true).command).toBe(
    "Close the quote in the command.",
  );
});

it("refuses a new server for an agent that already has the most", () => {
  const taken = Array.from({ length: 32 }, (_, at) => `s${at}`);
  expect(check(stdio("npx x", "more"), taken, true).name).toBe(
    "An agent may have at most 32 tool servers.",
  );
});

it("does not check the name of a server that is only being edited", () => {
  expect(check(stdio("npx x", "docs"), ["docs"], false)).toEqual({});
});

it("needs an http or https address for an http server", () => {
  for (const url of ["", "example.org/mcp", "ftp://example.org", "http://"])
    expect(check(http(url), [], true).url).toBe(
      "Use an http:// or https:// address.",
    );
  expect(check(http("http://localhost:8080/mcp"), [], true)).toEqual({});
  expect(check(http("https://example.org/a b"), [], true).url).toBe(
    "Use an http:// or https:// address.",
  );
});

it.each([
  "npx server --token=abc123",
  "npx server --api-key abc123",
  "API_KEY=abc123 npx server",
  "npx server sk-abcdefghijklmnopqrstuvwx",
  "npx server ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "curl -H 'Authorization: Bearer abc'",
])("refuses a command that holds a secret: %s", (command) => {
  expect(check(stdio(command), [], true).command).toBe(SECRET_MESSAGE);
});

it.each([
  "npx server --token-file /etc/token",
  "npx server --tokens",
  "npx server --stdio",
  `npx server --token=${ref("TOKEN")}`,
])("accepts a command that only names a secret: %s", (command) => {
  expect(check(stdio(command), [], true).command).toBeUndefined();
});

it.each([
  "https://user:pass@example.org/mcp",
  "https://example.org/mcp?token=abc123",
  "https://example.org/mcp?api_key=abc123",
])("refuses an address that holds a secret: %s", (url) => {
  expect(check(http(url), [], true).url).toBe(SECRET_MESSAGE);
});

it("accepts an address whose query only names a secret", () => {
  expect(
    check(http(`https://example.org/mcp?token=${ref("TOKEN")}`), [], true).url,
  ).toBeUndefined();
  expect(check(http("https://example.org/mcp?page=2"), [], true)).toEqual({});
});
