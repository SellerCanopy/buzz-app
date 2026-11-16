// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { create } from "@bufbuild/protobuf";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentToolsSettings } from "./AgentToolsSettings";
import type { Client } from "./engine/client";
import {
  AgentLoginStatusSchema,
  AgentToolsChangeSchema,
  GetHiveHealthResponseSchema,
  ListAgentToolServersResponseSchema,
  type AgentToolsChange,
} from "./gen/kiln/engine/v1/engine_pb";

afterEach(cleanup);

/** A reference to a secret by name, which a spec may hold. */
const ref = (name: string) => `\${${name}}`;

const linear = {
  name: "linear",
  transport: "http",
  specJson: JSON.stringify({
    url: "https://example.org/linear/mcp",
    headers: { Authorization: `Bearer ${ref("LINEAR_API_KEY")}` },
  }),
};
const github = {
  name: "github",
  transport: "stdio",
  specJson: JSON.stringify({
    command: "npx",
    args: ["github-server", "--stdio"],
  }),
};
const lists = () => [
  { agent: "builder", servers: [github, linear] },
  { agent: "reviewer", servers: [] },
];

const change = (
  fields: {
    agent?: { agent: string; servers: (typeof github)[] };
    applied?: boolean;
    restarted?: boolean;
    applyError?: string;
  } = {},
) =>
  create(AgentToolsChangeSchema, {
    agent: { agent: "builder", servers: [github, linear] },
    applied: true,
    restarted: true,
    ...fields,
  });

function show(
  options: {
    agents?: ReturnType<typeof lists>;
    issues?: { agent: string; problem: string }[];
    set?: AgentToolsChange | Error;
    remove?: AgentToolsChange | Error;
    /** The first read of the list, or of the settings check, fails with this. */
    listFails?: Error;
    healthFails?: Error;
  } = {},
) {
  const client = {
    listAgentToolServers: vi.fn(async () =>
      create(ListAgentToolServersResponseSchema, {
        agents: options.agents ?? lists(),
      }),
    ),
    getHiveHealth: vi.fn(async () =>
      create(GetHiveHealthResponseSchema, {
        allowlistApplied: options.issues?.length ? "no" : "yes",
        agentIssues: options.issues ?? [],
      }),
    ),
    getAgentLoginStatus: vi.fn(async () =>
      create(AgentLoginStatusSchema, { state: "needs-sign-in" }),
    ),
    setAgentToolServer: vi.fn(async () => {
      if (options.set instanceof Error) throw options.set;
      return options.set ?? change();
    }),
    removeAgentToolServer: vi.fn(async () => {
      if (options.remove instanceof Error) throw options.remove;
      return options.remove ?? change();
    }),
  };
  if (options.listFails)
    client.listAgentToolServers.mockRejectedValueOnce(options.listFails);
  if (options.healthFails)
    client.getHiveHealth.mockRejectedValueOnce(options.healthFails);
  render(<AgentToolsSettings client={client as unknown as Client} />);
  return client;
}

const group = (agent: string) =>
  screen.findByRole("region", { name: `Tool servers of ${agent}` });
/** The dialog's own buttons, since the page behind a modal is hidden from the accessibility tree. */
const inDialog = () => within(screen.getByRole("dialog"));

it("lists each agent's tool servers with what each runs or where it is", async () => {
  show();
  const builder = await group("builder");
  expect(within(builder).getByText("github")).toBeVisible();
  expect(
    within(builder).getByText("Runs npx github-server --stdio"),
  ).toBeVisible();
  expect(within(builder).getByText("linear")).toBeVisible();
  expect(
    within(builder).getByText(
      "Hosted server at https://example.org/linear/mcp",
    ),
  ).toBeVisible();
  const reviewer = await group("reviewer");
  expect(within(reviewer).getByText("No tool servers.")).toBeVisible();
  expect(
    screen.getByText("Tool servers each agent can use during a stage."),
  ).toBeVisible();
});

it("says so when no agent is set up, and offers no add", async () => {
  show({ agents: [] });
  expect(await screen.findByText(/No agents are set up/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Add tool server" }),
  ).toBeDisabled();
});

it("says what went wrong when the list cannot be read and Retry reads it again", async () => {
  const user = userEvent.setup();
  show({ listFails: new Error("Beehive is not reachable") });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await group("builder")).toBeVisible();
});

it("adds a tool server with its command split into arguments, and says the agent restarted", async () => {
  const user = userEvent.setup();
  const client = show({
    set: change({
      agent: {
        agent: "reviewer",
        servers: [{ name: "docs", transport: "stdio", specJson: "{}" }],
      },
    }),
  });
  await group("builder");
  await user.click(screen.getByRole("button", { name: "Add tool server" }));
  const dialog = inDialog();
  await user.click(await dialog.findByRole("combobox", { name: "Agent" }));
  await user.click(await screen.findByRole("option", { name: "reviewer" }));
  await user.type(dialog.getByLabelText("Name"), "docs");
  await user.type(
    dialog.getByLabelText("Command and arguments"),
    "npx docs-server --stdio",
  );
  await user.click(dialog.getByRole("button", { name: "Save server" }));
  await vi.waitFor(() =>
    expect(client.setAgentToolServer).toHaveBeenCalledWith("reviewer", {
      name: "docs",
      transport: "stdio",
      spec: { command: "npx", args: ["docs-server", "--stdio"] },
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Saved docs on reviewer. reviewer restarted, and a restarted agent restarts the work it is doing now.",
  );
  // The list the engine answered with is on screen, and health is read again.
  expect(within(await group("reviewer")).getByText("docs")).toBeVisible();
  expect(client.getHiveHealth).toHaveBeenCalledTimes(2);
  expect(client.listAgentToolServers).toHaveBeenCalledTimes(1);
});

it("adds an http server by its address", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("builder");
  await user.click(screen.getByRole("button", { name: "Add tool server" }));
  const dialog = inDialog();
  await user.type(dialog.getByLabelText("Name"), "docs");
  await user.click(await dialog.findByRole("combobox", { name: "Transport" }));
  await user.click(
    await screen.findByRole("option", { name: "Hosted server (http)" }),
  );
  await user.type(
    dialog.getByLabelText("Address"),
    "https://example.org/docs/mcp",
  );
  await user.click(dialog.getByRole("button", { name: "Save server" }));
  await vi.waitFor(() =>
    expect(client.setAgentToolServer).toHaveBeenCalledWith("builder", {
      name: "docs",
      transport: "http",
      spec: { url: "https://example.org/docs/mcp" },
    }),
  );
});

it("puts the focus on the name when adding", async () => {
  const user = userEvent.setup();
  show();
  await group("builder");
  await user.click(screen.getByRole("button", { name: "Add tool server" }));
  await vi.waitFor(() =>
    expect(inDialog().getByLabelText("Name")).toHaveFocus(),
  );
});

it("tells the person a save restarts the agent and its current work, before the save", async () => {
  const user = userEvent.setup();
  show();
  await group("builder");
  await user.click(screen.getByRole("button", { name: "Add tool server" }));
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "a restarted agent restarts the work it is doing now",
  );
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "A tool server cannot hold a secret yet; secrets come in a later phase.",
  );
});

it("edits a server under its own name and keeps the references it holds", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("builder");
  await user.click(
    screen.getByRole("button", { name: "Edit linear on builder" }),
  );
  const dialog = inDialog();
  expect(dialog.getByLabelText("Name")).toBeDisabled();
  expect(dialog.getByLabelText("Name")).toHaveValue("linear");
  expect(dialog.getByRole("combobox", { name: "Agent" })).toBeDisabled();
  expect(dialog.getByText("Keeps its headers: Authorization.")).toBeVisible();
  const address = dialog.getByLabelText("Address");
  await vi.waitFor(() => expect(address).toHaveFocus());
  await user.clear(address);
  await user.type(address, "https://example.org/linear/v2");
  await user.click(dialog.getByRole("button", { name: "Save server" }));
  await vi.waitFor(() =>
    expect(client.setAgentToolServer).toHaveBeenCalledWith("builder", {
      name: "linear",
      transport: "http",
      spec: {
        url: "https://example.org/linear/v2",
        headers: { Authorization: `Bearer ${ref("LINEAR_API_KEY")}` },
      },
    }),
  );
});

it("says the agent did not need to restart when its files did not change", async () => {
  const user = userEvent.setup();
  show({ set: change({ restarted: false }) });
  await group("builder");
  await user.click(
    screen.getByRole("button", { name: "Edit github on builder" }),
  );
  await user.click(inDialog().getByRole("button", { name: "Save server" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Saved github on builder. builder did not need to restart.",
  );
});

it("says a change was saved and not applied, with the host's reason", async () => {
  const user = userEvent.setup();
  show({
    set: change({
      applied: false,
      restarted: false,
      applyError: "the supervisor is not reachable",
    }),
  });
  await group("builder");
  await user.click(
    screen.getByRole("button", { name: "Edit github on builder" }),
  );
  await user.click(inDialog().getByRole("button", { name: "Save server" }));
  const note = await screen.findByRole("region", {
    name: "Saved, but builder does not have the change yet",
  });
  expect(note).toHaveTextContent(
    "The supervisor is not reachable. The change is kept",
  );
  expect(note).toHaveTextContent(
    "The change is kept, and the next change to this agent applies its whole list again.",
  );
  expect(screen.queryByRole("status")).toBeNull();
});

it("checks the name and the command before asking the engine, and keeps what was typed", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("builder");
  await user.click(screen.getByRole("button", { name: "Add tool server" }));
  const dialog = inDialog();
  await user.click(dialog.getByRole("button", { name: "Save server" }));
  expect(
    await dialog.findByText("Enter a name for the tool server."),
  ).toBeVisible();
  expect(
    dialog.getByText("Enter the command that starts the server."),
  ).toBeVisible();
  await user.type(dialog.getByLabelText("Name"), "github");
  await user.type(dialog.getByLabelText("Command and arguments"), "npx x");
  await user.click(dialog.getByRole("button", { name: "Save server" }));
  expect(
    await dialog.findByText(
      "This agent already has a tool server with that name.",
    ),
  ).toBeVisible();
  expect(dialog.getByLabelText("Command and arguments")).toHaveValue("npx x");
  expect(client.setAgentToolServer).not.toHaveBeenCalled();
});

it("needs an http address for a hosted server", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("builder");
  await user.click(screen.getByRole("button", { name: "Add tool server" }));
  const dialog = inDialog();
  await user.type(dialog.getByLabelText("Name"), "docs");
  await user.click(await dialog.findByRole("combobox", { name: "Transport" }));
  await user.click(
    await screen.findByRole("option", { name: "Hosted server (http)" }),
  );
  await user.type(dialog.getByLabelText("Address"), "ftp://example.org");
  await user.click(dialog.getByRole("button", { name: "Save server" }));
  expect(
    await dialog.findByText("Use an http:// or https:// address."),
  ).toBeVisible();
  expect(client.setAgentToolServer).not.toHaveBeenCalled();
});

it("refuses a command that holds a secret and says secrets come later", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("builder");
  await user.click(screen.getByRole("button", { name: "Add tool server" }));
  const dialog = inDialog();
  await user.type(dialog.getByLabelText("Name"), "docs");
  await user.type(
    dialog.getByLabelText("Command and arguments"),
    "npx docs --token=abc123",
  );
  await user.click(dialog.getByRole("button", { name: "Save server" }));
  expect(
    await dialog.findByText(/Secrets come in a later phase/, {
      selector: "[role=alert]",
    }),
  ).toBeVisible();
  expect(client.setAgentToolServer).not.toHaveBeenCalled();
});

it("shows the engine's refusal in the dialog and keeps the form for another try", async () => {
  const user = userEvent.setup();
  const client = show({
    set: new Error("an agent may have at most 32 tool servers"),
  });
  await group("builder");
  await user.click(screen.getByRole("button", { name: "Add tool server" }));
  const dialog = inDialog();
  await user.type(dialog.getByLabelText("Name"), "docs");
  await user.type(dialog.getByLabelText("Command and arguments"), "npx docs");
  await user.click(dialog.getByRole("button", { name: "Save server" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent(
    "an agent may have at most 32 tool servers",
  );
  expect(dialog.getByLabelText("Name")).toHaveValue("docs");
  expect(screen.queryByRole("status")).toBeNull();
  expect(client.setAgentToolServer).toHaveBeenCalledTimes(1);
});

it("asks before it removes a server, with Cancel first, and removes nothing on Cancel", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("builder");
  await user.click(
    screen.getByRole("button", { name: "Remove github from builder" }),
  );
  const confirm = await screen.findByRole("alertdialog");
  expect(confirm).toHaveTextContent("Remove github from builder?");
  expect(confirm).toHaveTextContent(
    "a restarted agent restarts the work it is doing now",
  );
  await vi.waitFor(() =>
    expect(
      within(confirm).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(client.removeAgentToolServer).not.toHaveBeenCalled();
});

it("removes a server once confirmed and shows the engine's list", async () => {
  const user = userEvent.setup();
  const client = show({
    remove: change({
      agent: { agent: "builder", servers: [linear] },
      restarted: true,
    }),
  });
  await group("builder");
  await user.click(
    screen.getByRole("button", { name: "Remove github from builder" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove tool server",
    }),
  );
  await vi.waitFor(() =>
    expect(client.removeAgentToolServer).toHaveBeenCalledWith(
      "builder",
      "github",
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Removed github from builder. builder restarted",
  );
  const builder = await group("builder");
  expect(within(builder).queryByText("github")).toBeNull();
  expect(within(builder).getByText("linear")).toBeVisible();
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Add tool server" }),
    ).toHaveFocus(),
  );
});

it("keeps the confirmation open with the engine's answer when a removal is refused", async () => {
  const user = userEvent.setup();
  show({ remove: new Error("agent builder has no tool server named github") });
  await group("builder");
  await user.click(
    screen.getByRole("button", { name: "Remove github from builder" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove tool server",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "agent builder has no tool server named github",
  );
  expect(screen.getByRole("alertdialog")).toBeVisible();
});

it("shows each agent the host reports as not set up for stage threads", async () => {
  show({
    issues: [
      {
        agent: "builder",
        problem:
          "session_policy is channel, and a stage thread needs thread; the Beehive account is not in its respond-to list",
      },
    ],
  });
  const note = await screen.findByRole("region", {
    name: "builder is not set up for stage threads",
  });
  expect(note).toHaveTextContent("session_policy is channel");
  expect(note).toHaveTextContent("not in its respond-to list");
});

it("shows no agent warning when every agent is set up", async () => {
  show();
  await group("builder");
  expect(screen.queryByText(/not set up for stage threads/)).toBeNull();
});

it("says so when the settings check fails, keeps the list, and checks again on request", async () => {
  const user = userEvent.setup();
  show({ healthFails: new Error("no health") });
  expect(await group("builder")).toBeVisible();
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Could not check whether the agents are set up for stage threads. no health",
  );
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
});
