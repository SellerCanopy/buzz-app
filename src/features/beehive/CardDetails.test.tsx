// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { Details } from "./CardPage";
import { CardSchema } from "./gen/kiln/engine/v1/engine_pb";

afterEach(cleanup);

const card = (fields: Record<string, unknown> = {}) =>
  create(CardSchema, {
    id: "c1",
    title: "Fix login",
    state: "running",
    workflow: "ship",
    ...fields,
  });

it("shows the card branch and the pull request as a link with its state", () => {
  render(
    <Details
      card={card({
        branch: "buzz/8b93fa58-fix-login",
        pullRequest: {
          number: 12,
          url: "https://github.example.org/example-org/api/pull/12",
          state: "open",
          draft: true,
        },
      })}
    />,
  );
  expect(screen.getByText("buzz/8b93fa58-fix-login")).toBeVisible();
  const link = screen.getByRole("link", { name: "#12" });
  expect(link).toHaveAttribute(
    "href",
    "https://github.example.org/example-org/api/pull/12",
  );
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByText(/draft/)).toBeVisible();
});

it("names a merged pull request by its state, not as a draft", () => {
  render(
    <Details
      card={card({
        pullRequest: {
          number: 12,
          url: "https://github.example.org/example-org/api/pull/12",
          state: "merged",
          draft: true,
        },
      })}
    />,
  );
  expect(screen.getByText(/merged/)).toBeVisible();
  expect(screen.queryByText(/draft/)).toBeNull();
});

it("shows an address that is not a web address as text, never as a link", () => {
  render(
    <Details
      card={card({
        pullRequest: {
          number: 12,
          url: "javascript:alert(1)",
          state: "open",
          draft: false,
        },
      })}
    />,
  );
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(/#12/)).toBeVisible();
});

it("leaves out the branch and the pull request for a card with neither", () => {
  render(<Details card={card()} />);
  expect(screen.queryByText("Branch")).toBeNull();
  expect(screen.queryByText("Pull request")).toBeNull();
});
