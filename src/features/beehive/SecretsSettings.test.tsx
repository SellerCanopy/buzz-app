// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { create } from "@bufbuild/protobuf";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Client } from "./engine/client";
import {
  ListAgentToolServersResponseSchema,
  ListSecretNamesResponseSchema,
  SecretChangeSchema,
  type SecretChange,
} from "./gen/kiln/engine/v1/engine_pb";
import { SecretsSettings } from "./SecretsSettings";

/** A value the tests send. It must appear nowhere on screen and in no log. */
const VALUE = "tok_KnownValue.9f8e7d";

const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
  vi.spyOn(console, level).mockImplementation(() => undefined),
);
beforeEach(() => {
  for (const spy of logs) spy.mockClear();
});
afterEach(cleanup);

type Names = {
  team: { name: string }[];
  agents: { agent: string; secret: { name: string } }[];
  grants: { agent: string; name: string }[];
};
const names = (): Names => ({
  team: [{ name: "GH_TOKEN" }, { name: "DOCS_TOKEN" }],
  agents: [{ agent: "builder", secret: { name: "LINEAR_KEY" } }],
  grants: [{ agent: "builder", name: "GH_TOKEN" }],
});

const reply = (
  applied: {
    agent: string;
    applied?: boolean;
    restarted?: boolean;
    applyError?: string;
  }[] = [{ agent: "builder", applied: true, restarted: true }],
) => create(SecretChangeSchema, { applied });

function show(
  options: {
    names?: Names;
    agents?: string[];
    change?: SecretChange | Error;
    listFails?: Error;
  } = {},
) {
  const answer = async () => {
    if (options.change instanceof Error) throw options.change;
    return options.change ?? reply();
  };
  const client = {
    listSecretNames: vi.fn(async () =>
      create(ListSecretNamesResponseSchema, options.names ?? names()),
    ),
    listAgentToolServers: vi.fn(async () =>
      create(ListAgentToolServersResponseSchema, {
        agents: (options.agents ?? ["builder", "reviewer"]).map((agent) => ({
          agent,
          servers: [],
        })),
      }),
    ),
    setTeamSecret: vi.fn(answer),
    setAgentSecret: vi.fn(answer),
    grantTeamSecret: vi.fn(answer),
    revokeTeamSecret: vi.fn(answer),
  };
  if (options.listFails)
    client.listSecretNames.mockRejectedValueOnce(options.listFails);
  render(<SecretsSettings client={client as unknown as Client} />);
  return client;
}

const group = (label: string) => screen.findByRole("region", { name: label });
const inDialog = () => within(screen.getByRole("dialog"));
const open = async (name: string) => {
  await group("Team secrets");
  await userEvent.click(screen.getByRole("button", { name }));
};

/** The known value is nowhere on the page, in any field or in any log. */
function expectNoValue() {
  expect(document.body.textContent).not.toContain(VALUE);
  expect(document.body.innerHTML).not.toContain(VALUE);
  for (const input of document.querySelectorAll("input"))
    expect(input.value).not.toContain(VALUE);
  for (const spy of logs)
    expect(JSON.stringify(spy.mock.calls)).not.toContain(VALUE);
}

it("lists the team secrets with the agents each is granted to, and what each agent holds", async () => {
  show();
  const team = await group("Team secrets");
  expect(within(team).getByText("GH_TOKEN")).toBeVisible();
  expect(within(team).getByText("Granted to builder.")).toBeVisible();
  expect(within(team).getByText("DOCS_TOKEN")).toBeVisible();
  expect(within(team).getByText("Not granted to any agent.")).toBeVisible();
  const builder = await group("Secrets of builder");
  expect(within(builder).getByText("LINEAR_KEY")).toBeVisible();
  expect(
    within(builder).getByText(/Its own secret\. It wins over a team secret/),
  ).toBeVisible();
  expect(within(builder).getByText("GH_TOKEN")).toBeVisible();
  expect(
    within(builder).getByText("Team secret granted to this agent."),
  ).toBeVisible();
  expect(
    within(await group("Secrets of reviewer")).getByText("No secrets."),
  ).toBeVisible();
});

it("says a value cannot be read back, only replaced", async () => {
  show();
  await group("Team secrets");
  expect(
    screen.getByText(/A value cannot be read back, only replaced\./),
  ).toBeVisible();
});

it("says so when no team secret exists yet", async () => {
  show({ names: { team: [], agents: [], grants: [] } });
  expect(await screen.findByText(/No team secrets yet/)).toBeVisible();
});

it("says what went wrong when the list cannot be read and Retry reads it again", async () => {
  const user = userEvent.setup();
  show({ listFails: new Error("Beehive is not reachable") });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beehive is not reachable",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await group("Team secrets")).toBeVisible();
});

it("sets a team secret: the client gets the value, the field is empty at once, and the page never holds it", async () => {
  const user = userEvent.setup();
  const client = show();
  let release: (change: SecretChange) => void = () => undefined;
  client.setTeamSecret.mockImplementationOnce(
    () => new Promise<SecretChange>((resolve) => (release = resolve)),
  );
  await open("Add team secret");
  const dialog = inDialog();
  const field = dialog.getByLabelText("Value");
  expect(field).toHaveAttribute("type", "password");
  expect(field).toHaveAttribute("autocomplete", "off");
  await user.type(dialog.getByLabelText("Name"), "NEW_TOKEN");
  await user.type(field, VALUE);
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  await vi.waitFor(() =>
    expect(client.setTeamSecret).toHaveBeenCalledWith("NEW_TOKEN", VALUE),
  );
  // The call is still out, and the value is already gone from the field and the page.
  expect(field).toHaveValue("");
  expectNoValue();
  release(reply([{ agent: "builder", applied: true, restarted: true }]));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Saved NEW_TOKEN. builder restarted, and a restarted agent restarts the work it is doing now.",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(client.listSecretNames).toHaveBeenCalledTimes(2);
  expectNoValue();
});

it("empties the value when the save fails, keeps the name, and shows the engine's refusal as given", async () => {
  const user = userEvent.setup();
  const client = show({
    change: new Error("no secret store is configured (the value is not shown)"),
  });
  await open("Add team secret");
  const dialog = inDialog();
  await user.type(dialog.getByLabelText("Name"), "NEW_TOKEN");
  await user.type(dialog.getByLabelText("Value"), VALUE);
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent(
    "no secret store is configured (the value is not shown)",
  );
  expect(dialog.getByLabelText("Value")).toHaveValue("");
  expect(dialog.getByLabelText("Name")).toHaveValue("NEW_TOKEN");
  expect(client.setTeamSecret).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("status")).toBeNull();
  expectNoValue();
  // A second try needs the value typed again.
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  expect(await dialog.findByText("Enter the value.")).toBeVisible();
  expect(client.setTeamSecret).toHaveBeenCalledTimes(1);
});

it("replaces a team secret under its own name, with the name locked", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("Team secrets");
  await user.click(screen.getByRole("button", { name: "Replace GH_TOKEN" }));
  const dialog = inDialog();
  expect(dialog.getByLabelText("Name")).toBeDisabled();
  expect(dialog.getByLabelText("Name")).toHaveValue("GH_TOKEN");
  await vi.waitFor(() => expect(dialog.getByLabelText("Value")).toHaveFocus());
  await user.type(dialog.getByLabelText("Value"), VALUE);
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  await vi.waitFor(() =>
    expect(client.setTeamSecret).toHaveBeenCalledWith("GH_TOKEN", VALUE),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Saved GH_TOKEN.",
  );
  expectNoValue();
});

it("tells the person, before the save, that agents restart and the value is write only", async () => {
  show();
  await open("Add team secret");
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "A value cannot be read back, only replaced.",
  );
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "a restarted agent restarts the work it is doing now",
  );
});

it("sets an agent's own secret", async () => {
  const user = userEvent.setup();
  const client = show({
    change: reply([{ agent: "reviewer", applied: true, restarted: false }]),
  });
  await open("Add a secret for reviewer");
  const dialog = inDialog();
  expect(dialog.getByText(/wins over a team secret/)).toBeVisible();
  await user.type(dialog.getByLabelText("Name"), "DOCS_KEY");
  await user.type(dialog.getByLabelText("Value"), VALUE);
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  await vi.waitFor(() =>
    expect(client.setAgentSecret).toHaveBeenCalledWith(
      "reviewer",
      "DOCS_KEY",
      VALUE,
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Saved DOCS_KEY. reviewer did not need to restart.",
  );
  expect(client.setTeamSecret).not.toHaveBeenCalled();
  expectNoValue();
});

it("replaces an agent's own secret", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("Secrets of builder");
  await user.click(
    screen.getByRole("button", { name: "Replace LINEAR_KEY on builder" }),
  );
  await user.type(inDialog().getByLabelText("Value"), VALUE);
  await user.click(inDialog().getByRole("button", { name: "Save secret" }));
  await vi.waitFor(() =>
    expect(client.setAgentSecret).toHaveBeenCalledWith(
      "builder",
      "LINEAR_KEY",
      VALUE,
    ),
  );
});

it("checks the name and the value before asking the engine, and never repeats the value", async () => {
  const user = userEvent.setup();
  const client = show();
  await open("Add team secret");
  const dialog = inDialog();
  const save = () =>
    user.click(dialog.getByRole("button", { name: "Save secret" }));
  await save();
  expect(await dialog.findByText("Enter a name for the secret.")).toBeVisible();
  expect(dialog.getByText("Enter the value.")).toBeVisible();

  await user.type(dialog.getByLabelText("Name"), "lower_case");
  await save();
  expect(
    await dialog.findByText(/Use capital letters, digits and _/),
  ).toBeVisible();

  await user.clear(dialog.getByLabelText("Name"));
  await user.type(dialog.getByLabelText("Name"), "BUZZ_PRIVATE_KEY");
  await user.type(dialog.getByLabelText("Value"), VALUE);
  await save();
  expect(await dialog.findByText(/BUZZ_PRIVATE_KEY is reserved/)).toBeVisible();

  await user.clear(dialog.getByLabelText("Name"));
  await user.type(dialog.getByLabelText("Name"), "CLAUDE_X");
  await save();
  expect(await dialog.findByText(/CLAUDE_X is reserved/)).toBeVisible();

  await user.clear(dialog.getByLabelText("Name"));
  await user.type(dialog.getByLabelText("Name"), "HOME");
  await save();
  expect(await dialog.findByText(/HOME is reserved/)).toBeVisible();

  await user.clear(dialog.getByLabelText("Name"));
  await user.type(dialog.getByLabelText("Name"), "OK_NAME");
  await user.clear(dialog.getByLabelText("Value"));
  await user.type(dialog.getByLabelText("Value"), "has space");
  await save();
  expect(
    await dialog.findByText(/A value may hold only letters, digits/),
  ).toBeVisible();
  expect(client.setTeamSecret).not.toHaveBeenCalled();
  expectNoValue();
});

it("refuses a value over 4096 bytes without sending it", async () => {
  const user = userEvent.setup();
  const client = show();
  await open("Add team secret");
  const dialog = inDialog();
  await user.type(dialog.getByLabelText("Name"), "BIG_TOKEN");
  // Paste, since typing 4097 characters one at a time is slow.
  await user.click(dialog.getByLabelText("Value"));
  await user.paste("a".repeat(4097));
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  expect(
    await dialog.findByText("A value may be at most 4096 bytes."),
  ).toBeVisible();
  expect(client.setTeamSecret).not.toHaveBeenCalled();
});

it("takes a value of exactly 4096 bytes", async () => {
  const user = userEvent.setup();
  const client = show();
  await open("Add team secret");
  const dialog = inDialog();
  await user.type(dialog.getByLabelText("Name"), "BIG_TOKEN");
  await user.click(dialog.getByLabelText("Value"));
  await user.paste("a".repeat(4096));
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  await vi.waitFor(() => expect(client.setTeamSecret).toHaveBeenCalled());
});

it("refuses a 65th secret for an agent, and says so before the grant", async () => {
  const user = userEvent.setup();
  const many = Array.from({ length: 63 }, (_, at) => ({
    agent: "builder",
    secret: { name: `OWN_${at}` },
  }));
  const client = show({
    names: {
      team: [{ name: "GH_TOKEN" }, { name: "DOCS_TOKEN" }],
      agents: many,
      grants: [{ agent: "builder", name: "GH_TOKEN" }],
    },
  });
  await open("Add a secret for builder");
  const dialog = inDialog();
  await user.type(dialog.getByLabelText("Name"), "ONE_MORE");
  await user.type(dialog.getByLabelText("Value"), VALUE);
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  expect(
    await dialog.findByText("An agent may have at most 64 secrets."),
  ).toBeVisible();
  // Replacing one it already has needs no room.
  await user.clear(dialog.getByLabelText("Name"));
  await user.type(dialog.getByLabelText("Name"), "OWN_1");
  await user.click(dialog.getByRole("button", { name: "Save secret" }));
  await vi.waitFor(() =>
    expect(client.setAgentSecret).toHaveBeenCalledWith(
      "builder",
      "OWN_1",
      VALUE,
    ),
  );
});

/** An agent that holds `own` secrets of its own and is granted GH_TOKEN, with DOCS_TOKEN still free. */
const holding = (own: number): Names => ({
  team: [{ name: "GH_TOKEN" }, { name: "DOCS_TOKEN" }],
  agents: Array.from({ length: own }, (_, at) => ({
    agent: "builder",
    secret: { name: `OWN_${at}` },
  })),
  grants: [{ agent: "builder", name: "GH_TOKEN" }],
});

it("refuses to give a team secret to an agent that holds 64, and sends nothing", async () => {
  const client = show({ names: holding(63) });
  await open("Give builder a team secret");
  expect(
    await inDialog().findByText("An agent may have at most 64 secrets."),
  ).toBeVisible();
  const give = inDialog().getByRole("button", { name: "Give secret" });
  expect(give).toBeDisabled();
  await userEvent.click(give);
  expect(client.grantTeamSecret).not.toHaveBeenCalled();
});

it("gives a team secret to an agent that holds 63, which leaves room for exactly one", async () => {
  const user = userEvent.setup();
  const client = show({ names: holding(62) });
  await open("Give builder a team secret");
  expect(inDialog().queryByText(/at most 64 secrets/)).toBeNull();
  await user.click(inDialog().getByRole("button", { name: "Give secret" }));
  await vi.waitFor(() =>
    expect(client.grantTeamSecret).toHaveBeenCalledWith(
      "builder",
      "DOCS_TOKEN",
    ),
  );
});

it("says a granted team secret is hidden by an own secret of the same name, and still offers Revoke", async () => {
  show({
    names: {
      team: [{ name: "GH_TOKEN" }],
      agents: [{ agent: "builder", secret: { name: "GH_TOKEN" } }],
      grants: [{ agent: "builder", name: "GH_TOKEN" }],
    },
  });
  const builder = await group("Secrets of builder");
  expect(
    within(builder).getByText(
      "Team secret, hidden by its own secret of the same name.",
    ),
  ).toBeVisible();
  expect(
    within(builder).queryByText("Team secret granted to this agent."),
  ).toBeNull();
  expect(
    within(builder).getByRole("button", {
      name: "Revoke GH_TOKEN from builder",
    }),
  ).toBeEnabled();
});

it("gives an agent a team secret it does not hold", async () => {
  const user = userEvent.setup();
  const client = show({
    change: reply([{ agent: "reviewer", applied: true, restarted: true }]),
  });
  await open("Give reviewer a team secret");
  const dialog = inDialog();
  await user.click(dialog.getByRole("button", { name: "Give secret" }));
  await vi.waitFor(() =>
    expect(client.grantTeamSecret).toHaveBeenCalledWith("reviewer", "GH_TOKEN"),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Gave GH_TOKEN to reviewer. reviewer restarted, and a restarted agent restarts the work it is doing now.",
  );
});

it("offers only the team secrets the agent does not hold", async () => {
  const user = userEvent.setup();
  show();
  await open("Give builder a team secret");
  await user.click(
    await inDialog().findByRole("combobox", { name: "Team secret" }),
  );
  expect(
    await screen.findByRole("option", { name: "DOCS_TOKEN" }),
  ).toBeVisible();
  expect(screen.queryByRole("option", { name: "GH_TOKEN" })).toBeNull();
});

it("offers no grant to an agent that already holds every team secret", async () => {
  show({
    names: {
      team: [{ name: "GH_TOKEN" }],
      agents: [],
      grants: [{ agent: "builder", name: "GH_TOKEN" }],
    },
  });
  await group("Team secrets");
  expect(
    screen.getByRole("button", { name: "Give builder a team secret" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Give reviewer a team secret" }),
  ).toBeEnabled();
});

it("shows the engine's answer when a grant is refused, and keeps the dialog", async () => {
  const user = userEvent.setup();
  show({ change: new Error("no team secret is named GH_TOKEN") });
  await open("Give reviewer a team secret");
  await user.click(inDialog().getByRole("button", { name: "Give secret" }));
  expect(await inDialog().findByRole("alert")).toHaveTextContent(
    "no team secret is named GH_TOKEN",
  );
});

it("asks before it revokes, with Cancel first, and revokes nothing on Cancel", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("Secrets of builder");
  await user.click(
    screen.getByRole("button", { name: "Revoke GH_TOKEN from builder" }),
  );
  const confirm = await screen.findByRole("alertdialog");
  expect(confirm).toHaveTextContent("Revoke GH_TOKEN from builder?");
  expect(confirm).toHaveTextContent(
    "The value stays for the agents that still hold it.",
  );
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
  expect(client.revokeTeamSecret).not.toHaveBeenCalled();
});

it("revokes once confirmed and says what happened to the agent", async () => {
  const user = userEvent.setup();
  const client = show();
  await group("Secrets of builder");
  await user.click(
    screen.getByRole("button", { name: "Revoke GH_TOKEN from builder" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke secret",
    }),
  );
  await vi.waitFor(() =>
    expect(client.revokeTeamSecret).toHaveBeenCalledWith("builder", "GH_TOKEN"),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Revoked GH_TOKEN from builder. builder restarted",
  );
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Add team secret" }),
    ).toHaveFocus(),
  );
});

it("keeps the confirmation open with the engine's answer when a revoke is refused", async () => {
  const user = userEvent.setup();
  show({ change: new Error("agent builder was not granted GH_TOKEN") });
  await group("Secrets of builder");
  await user.click(
    screen.getByRole("button", { name: "Revoke GH_TOKEN from builder" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke secret",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "agent builder was not granted GH_TOKEN",
  );
  expect(screen.getByRole("alertdialog")).toBeVisible();
});

it("says a change was saved and not applied, with the host's reason, and no restart claim", async () => {
  const user = userEvent.setup();
  show({
    change: reply([
      {
        agent: "builder",
        applied: false,
        applyError: "the supervisor is not reachable",
      },
    ]),
  });
  await group("Secrets of builder");
  await user.click(
    screen.getByRole("button", { name: "Revoke GH_TOKEN from builder" }),
  );
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke secret",
    }),
  );
  const note = await screen.findByRole("region", {
    name: "Saved, but builder does not have the change yet",
  });
  expect(note).toHaveTextContent("builder: The supervisor is not reachable.");
  expect(note).toHaveTextContent("The change is kept");
  expect(screen.queryByRole("status")).toBeNull();
});

it("sorts a change that reached several agents by what happened to each", async () => {
  const user = userEvent.setup();
  show({
    change: reply([
      { agent: "builder", applied: true, restarted: true },
      { agent: "reviewer", applied: true, restarted: false },
      { agent: "tester", applied: false, applyError: "no route to host" },
    ]),
  });
  await group("Team secrets");
  await user.click(screen.getByRole("button", { name: "Replace GH_TOKEN" }));
  await user.type(inDialog().getByLabelText("Value"), VALUE);
  await user.click(inDialog().getByRole("button", { name: "Save secret" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Saved GH_TOKEN. builder restarted, and a restarted agent restarts the work it is doing now. reviewer did not need to restart.",
  );
  expect(
    await screen.findByRole("region", {
      name: "Saved, but tester does not have the change yet",
    }),
  ).toHaveTextContent("tester: No route to host.");
});

it("says so when no agent holds the secret yet", async () => {
  const user = userEvent.setup();
  show({ change: reply([]) });
  await open("Add team secret");
  await user.type(inDialog().getByLabelText("Name"), "NEW_TOKEN");
  await user.type(inDialog().getByLabelText("Value"), VALUE);
  await user.click(inDialog().getByRole("button", { name: "Save secret" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Saved NEW_TOKEN. No agent holds it yet, so no agent changed.",
  );
});

it("keeps the list on screen and says so when it cannot be read again after a change", async () => {
  const user = userEvent.setup();
  const client = show();
  await open("Add team secret");
  client.listSecretNames.mockRejectedValueOnce(new Error("no list"));
  await user.type(inDialog().getByLabelText("Name"), "NEW_TOKEN");
  await user.type(inDialog().getByLabelText("Value"), VALUE);
  await user.click(inDialog().getByRole("button", { name: "Save secret" }));
  expect(
    await screen.findByText(/Could not read the secrets again\. no list/),
  ).toBeVisible();
  expect(await group("Team secrets")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await vi.waitFor(() =>
    expect(screen.queryByText(/Could not read the secrets again/)).toBeNull(),
  );
});

it("never shows the value in any state it passes through", async () => {
  const user = userEvent.setup();
  const client = show();
  // Failure, then success, then a refused grant, across both kinds of secret.
  client.setTeamSecret.mockRejectedValueOnce(new Error("store is down"));
  await open("Add team secret");
  await user.type(inDialog().getByLabelText("Name"), "NEW_TOKEN");
  await user.type(inDialog().getByLabelText("Value"), VALUE);
  expectNoValueInMarkup();
  await user.click(inDialog().getByRole("button", { name: "Save secret" }));
  await inDialog().findByRole("alert");
  expectNoValue();
  await user.type(inDialog().getByLabelText("Value"), VALUE);
  await user.click(inDialog().getByRole("button", { name: "Save secret" }));
  await screen.findByRole("status");
  expectNoValue();
  await user.click(
    screen.getByRole("button", { name: "Add a secret for builder" }),
  );
  await user.type(inDialog().getByLabelText("Name"), "OWN_ONE");
  await user.type(inDialog().getByLabelText("Value"), VALUE);
  await user.click(inDialog().getByRole("button", { name: "Save secret" }));
  await vi.waitFor(() => expect(client.setAgentSecret).toHaveBeenCalled());
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expectNoValue();
  // Every call carried the value only as its argument.
  expect(client.setTeamSecret).toHaveBeenCalledTimes(2);
});

/** What the page holds while a value is typed: the field has it, the markup and text do not. */
function expectNoValueInMarkup() {
  expect(document.body.textContent).not.toContain(VALUE);
  expect(document.body.innerHTML).not.toContain(VALUE);
}
