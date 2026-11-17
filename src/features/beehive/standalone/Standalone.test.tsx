// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Standalone, standaloneClient } from "./Standalone";

const CARD = "5f1c2d3e-0000-4000-8000-0000000000c1";
const ENGINE = "http://engine.test";

/** The engine as the page sees it: a Connect JSON reply for each call. */
let fetched: { path: string; authorization: string | null }[];
beforeEach(() => {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const name = path.slice(path.lastIndexOf("/") + 1);
      fetched.push({
        path: name,
        authorization: new Headers(init.headers).get("authorization"),
      });
      // A long poll parks until the page gives up on it.
      if (name === "PollEvents")
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        );
      const body =
        name === "ListCards"
          ? {
              cards: [
                {
                  id: CARD,
                  title: "Fix the thing",
                  workflow: "",
                  state: "idle",
                },
              ],
            }
          : name === "GetCard"
            ? { id: CARD, title: "Fix the thing", workflow: "", state: "idle" }
            : name === "WhoAmI"
              ? { role: "run", me: { userId: "a".repeat(64) } }
              : {};
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  window.__beehiveNative = { token: async () => "native-token" };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__beehiveNative;
});

const mount = () => render(<Standalone client={standaloneClient(ENGINE)} />);

it("loads the board with no relay, sending the native token", async () => {
  mount();
  expect(await screen.findByRole("region", { name: "Backlog" })).toBeVisible();
  expect(await screen.findByText("Fix the thing")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  expect(fetched.length).toBeGreaterThan(0);
  expect(fetched.every((c) => c.authorization === "Bearer native-token")).toBe(
    true,
  );
  expect(fetched.map((c) => c.path)).toContain("ListCards");
});

it("opens a card from the board and Close returns to the board", async () => {
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "Fix the thing" }),
  );
  const back = await screen.findByRole("button", { name: "Back to Board" });
  await userEvent.click(back);
  expect(await screen.findByRole("region", { name: "Backlog" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Back to Board" })).toBeNull();
});

it("waits for a shim that is injected after the page starts", async () => {
  delete window.__beehiveNative;
  mount();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(fetched).toHaveLength(0);
  window.__beehiveNative = { token: async () => "native-token" };
  expect(await screen.findByRole("region", { name: "Backlog" })).toBeVisible();
  expect(fetched.every((c) => c.authorization === "Bearer native-token")).toBe(
    true,
  );
});
