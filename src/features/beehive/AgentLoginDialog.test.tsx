// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { create } from "@bufbuild/protobuf";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentToolsSettings } from "./AgentToolsSettings";
import type { Client } from "./engine/client";
import { EngineError } from "./engine/transport";
import {
  AgentLoginStatusSchema,
  GetHiveHealthResponseSchema,
  ListAgentToolServersResponseSchema,
  PasteAgentLoginResponseSchema,
  StartAgentLoginResponseSchema,
} from "./gen/kiln/engine/v1/engine_pb";

/** The link and the address the tests use. Each must appear nowhere but the dialog's own link. */
const LINK = "https://example.org/oauth/authorize?state=KnownState";
const ADDRESS = "http://localhost:43111/callback?code=KnownCode.9f8e7d";

const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
  vi.spyOn(console, level).mockImplementation(() => undefined),
);
beforeEach(() => {
  for (const spy of logs) spy.mockClear();
});
afterEach(cleanup);

const github = {
  name: "github",
  transport: "stdio",
  specJson: JSON.stringify({ command: "npx", args: ["github-server"] }),
};
const linear = {
  name: "linear",
  transport: "http",
  specJson: JSON.stringify({ url: "https://example.org/linear/mcp" }),
};

const failure = (code: string, message: string) =>
  new EngineError(code, message, 400);

function show(
  options: {
    /** What each read of the status answers, in order; the last one repeats. */
    states?: (string | Error)[];
    start?: string | Error | (() => Promise<string>);
    paste?: boolean | Error | (() => Promise<boolean>);
    /** Render as the app does, where React runs every effect twice in development. */
    strict?: boolean;
  } = {},
) {
  const states = [...(options.states ?? ["needs-sign-in"])];
  const client = {
    listAgentToolServers: vi.fn(async () =>
      create(ListAgentToolServersResponseSchema, {
        agents: [{ agent: "builder", servers: [github, linear] }],
      }),
    ),
    getHiveHealth: vi.fn(async () => create(GetHiveHealthResponseSchema, {})),
    getAgentLoginStatus: vi.fn(async () => {
      const next = states.length > 1 ? states.shift() : states[0];
      if (next instanceof Error) throw next;
      return create(AgentLoginStatusSchema, {
        agent: "builder",
        server: "linear",
        state: next ?? "needs-sign-in",
      });
    }),
    startAgentLogin: vi.fn(async () => {
      const start = options.start ?? LINK;
      if (start instanceof Error) throw start;
      return create(StartAgentLoginResponseSchema, {
        url: typeof start === "function" ? await start() : start,
      });
    }),
    pasteAgentLogin: vi.fn(async () => {
      const paste = options.paste ?? true;
      if (paste instanceof Error) throw paste;
      return create(PasteAgentLoginResponseSchema, {
        signedIn: typeof paste === "function" ? await paste() : paste,
      });
    }),
  };
  const settings = <AgentToolsSettings client={client as unknown as Client} />;
  render(options.strict ? <StrictMode>{settings}</StrictMode> : settings);
  return client;
}

const dialog = () => within(screen.getByRole("dialog"));
/** Opens the dialog for linear and waits for the link to arrive. */
async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Connect linear on builder" }),
  );
  await dialog().findByRole("link", { name: "Open the sign-in link" });
}
const field = () => dialog().getByLabelText("Address");
const chip = (text: string) =>
  screen.findByText(text, { selector: ".beehive-chip" });

it("offers Connect on a hosted server only and reads its sign-in once the list is known", async () => {
  const client = show();
  expect(await chip("Needs sign-in")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Connect linear on builder" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Connect github on builder" }),
  ).toBeNull();
  expect(client.getAgentLoginStatus).toHaveBeenCalledTimes(1);
  expect(client.getAgentLoginStatus).toHaveBeenCalledWith(
    "builder",
    "linear",
    expect.any(AbortSignal),
  );
  expect(client.startAgentLogin).not.toHaveBeenCalled();
});

it("shows a signed-in server as connected and still offers Connect", async () => {
  show({ states: ["connected"] });
  expect(await chip("Connected")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Connect linear on builder" }),
  ).toBeVisible();
});

it("starts the sign-in and shows the link as an ordinary anchor with what to do", async () => {
  const user = userEvent.setup();
  const client = show();
  await connect(user);
  expect(client.startAgentLogin).toHaveBeenCalledWith("builder", "linear");
  const link = dialog().getByRole("link", { name: "Open the sign-in link" });
  expect(link).toHaveAttribute("href", LINK);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Open this link, sign in, then paste the address your browser ends on.",
  );
  expect(field()).toHaveAttribute("autocomplete", "off");
  expect(field()).toHaveAttribute("type", "text");
  await vi.waitFor(() => expect(field()).toHaveFocus());
});

it("starts the sign-in once even where effects run twice", async () => {
  const user = userEvent.setup();
  const client = show({ strict: true });
  await connect(user);
  expect(client.startAgentLogin).toHaveBeenCalledTimes(1);
});

it("sends the pasted address, empties the field while the call is out, and shows connected after", async () => {
  const user = userEvent.setup();
  let release: (signedIn: boolean) => void = () => undefined;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const client = show({
    states: ["needs-sign-in", "connected"],
    paste: () => gate,
  });
  await connect(user);
  await user.type(field(), ADDRESS);
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  await vi.waitFor(() =>
    expect(client.pasteAgentLogin).toHaveBeenCalledWith(
      "builder",
      "linear",
      ADDRESS,
    ),
  );
  // The call is still out: the address is already gone from the field and the screen.
  expect(field()).toHaveValue("");
  expect(document.body).not.toHaveTextContent("KnownCode");
  release(true);
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await chip("Connected")).toBeVisible();
  expect(client.getAgentLoginStatus).toHaveBeenCalledTimes(2);
  expect(document.body).not.toHaveTextContent("KnownCode");
  expect(document.body).not.toHaveTextContent("KnownState");
});

it("keeps the paste as connected when the status cannot be read afterwards", async () => {
  const user = userEvent.setup();
  show({ states: ["needs-sign-in", new Error("the host is busy")] });
  await connect(user);
  await user.type(field(), ADDRESS);
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  expect(await chip("Connected")).toBeVisible();
});

it("asks for an address before it sends anything", async () => {
  const user = userEvent.setup();
  const client = show();
  await connect(user);
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  expect(
    await dialog().findByText("Paste the address your browser ended on."),
  ).toBeVisible();
  expect(client.pasteAgentLogin).not.toHaveBeenCalled();
});

it("shows the engine's refusal of a wrong address, empties the field, and keeps the sign-in for another try", async () => {
  const user = userEvent.setup();
  const client = show();
  client.pasteAgentLogin.mockRejectedValueOnce(
    failure(
      "invalid_argument",
      "that is not the address the browser ended on: it must start with http://localhost: and a port, and carry a code (the address is not shown)",
    ),
  );
  await connect(user);
  await user.type(field(), "https://example.org/not-it?code=KnownCode");
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  expect(await dialog().findByRole("alert")).toHaveTextContent(
    "that is not the address the browser ended on",
  );
  expect(field()).toHaveValue("");
  expect(document.body).not.toHaveTextContent("KnownCode");
  // The link is still there and a second try goes through without starting again.
  expect(
    dialog().getByRole("link", { name: "Open the sign-in link" }),
  ).toBeVisible();
  await user.type(field(), ADDRESS);
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(client.startAgentLogin).toHaveBeenCalledTimes(1);
  expect(client.pasteAgentLogin).toHaveBeenCalledTimes(2);
});

it("says when the sign-in expired, drops the link, and starts again on Connect again", async () => {
  const user = userEvent.setup();
  const client = show();
  client.pasteAgentLogin.mockRejectedValueOnce(
    failure(
      "not_found",
      "no sign-in is waiting for this tool server (it may have expired); start it again",
    ),
  );
  await connect(user);
  await user.type(field(), ADDRESS);
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  expect(await dialog().findByRole("alert")).toHaveTextContent(
    "no sign-in is waiting for this tool server (it may have expired)",
  );
  expect(dialog().queryByRole("link")).toBeNull();
  expect(dialog().queryByLabelText("Address")).toBeNull();
  expect(document.body).not.toHaveTextContent("KnownCode");
  await user.click(dialog().getByRole("button", { name: "Connect again" }));
  await dialog().findByRole("link", { name: "Open the sign-in link" });
  expect(client.startAgentLogin).toHaveBeenCalledTimes(2);
  expect(dialog().queryByRole("alert")).toBeNull();
});

it("offers Connect again after the host refused an address it had read", async () => {
  const user = userEvent.setup();
  const client = show();
  client.pasteAgentLogin.mockRejectedValueOnce(
    failure(
      "invalid_argument",
      "the sign-in did not accept that address; start the sign-in again",
    ),
  );
  await connect(user);
  await user.type(field(), ADDRESS);
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  expect(await dialog().findByRole("alert")).toHaveTextContent(
    "start the sign-in again",
  );
  await user.click(dialog().getByRole("button", { name: "Connect again" }));
  await vi.waitFor(() =>
    expect(client.startAgentLogin).toHaveBeenCalledTimes(2),
  );
});

it("shows the host's reason when the sign-in cannot start, and Connect again tries again", async () => {
  const user = userEvent.setup();
  const client = show({
    start: failure(
      "failed_precondition",
      "no supervisor is configured (BUZZ_HIVE_SUPERVISOR_SOCKET), so no agent can be signed in",
    ),
  });
  await user.click(
    await screen.findByRole("button", { name: "Connect linear on builder" }),
  );
  expect(await dialog().findByRole("alert")).toHaveTextContent(
    "no supervisor is configured",
  );
  expect(dialog().queryByRole("link")).toBeNull();
  client.startAgentLogin.mockResolvedValueOnce(
    create(StartAgentLoginResponseSchema, { url: LINK }),
  );
  await user.click(dialog().getByRole("button", { name: "Connect again" }));
  expect(
    await dialog().findByRole("link", { name: "Open the sign-in link" }),
  ).toBeVisible();
});

it("does not open a link that is not a web address", async () => {
  const user = userEvent.setup();
  show({ start: "javascript:alert(1)" });
  await user.click(
    await screen.findByRole("button", { name: "Connect linear on builder" }),
  );
  expect(await dialog().findByRole("alert")).toHaveTextContent(
    "did not send a link that can be opened",
  );
  expect(dialog().queryByRole("link")).toBeNull();
});

it("shows the engine's text and no chip when the status cannot be read, and checks again on request", async () => {
  const user = userEvent.setup();
  const client = show({
    states: [
      failure("failed_precondition", "no supervisor is configured"),
      "connected",
    ],
  });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Could not check the tool server sign-ins. no supervisor is configured",
  );
  expect(screen.queryByText("Needs sign-in")).toBeNull();
  // The tool list is still there and Connect still works.
  expect(
    screen.getByRole("button", { name: "Connect linear on builder" }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Check sign-ins again" }),
  );
  expect(await chip("Connected")).toBeVisible();
  expect(client.getAgentLoginStatus).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Could not check the tool server/)).toBeNull();
});

it("drops the link and the field when the dialog closes, and a new Connect starts a new sign-in", async () => {
  const user = userEvent.setup();
  const client = show();
  await connect(user);
  await user.type(field(), ADDRESS);
  await user.click(dialog().getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Open the sign-in link" }),
  ).toBeNull();
  expect(document.body).not.toHaveTextContent("KnownCode");
  await user.click(
    screen.getByRole("button", { name: "Connect linear on builder" }),
  );
  await dialog().findByRole("link", { name: "Open the sign-in link" });
  expect(field()).toHaveValue("");
  expect(client.startAgentLogin).toHaveBeenCalledTimes(2);
  expect(client.pasteAgentLogin).not.toHaveBeenCalled();
});

it("writes neither the link nor the address to the console, whatever the paste does", async () => {
  const user = userEvent.setup();
  const client = show();
  client.pasteAgentLogin.mockRejectedValueOnce(
    failure("invalid_argument", "that is not the address the browser ended on"),
  );
  await connect(user);
  await user.type(field(), ADDRESS);
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  await dialog().findByRole("alert");
  await user.type(field(), ADDRESS);
  await user.click(dialog().getByRole("button", { name: "Paste address" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  for (const spy of logs)
    for (const call of spy.mock.calls) {
      const text = JSON.stringify(call);
      expect(text).not.toContain("KnownCode");
      expect(text).not.toContain("KnownState");
      expect(text).not.toContain("oauth/authorize");
    }
});
