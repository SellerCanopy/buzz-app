import { expect, it } from "vitest";
import {
  appliedLine,
  checkName,
  checkRoom,
  checkValue,
  list,
  reached,
} from "./secret";

it("takes capital letters, digits and underscores that start with a letter", () => {
  for (const ok of ["GH_TOKEN", "A", "X1_Y2", "A".repeat(64)])
    expect(checkName(ok), ok).toBeUndefined();
  for (const bad of [
    "",
    " ",
    "gh_token",
    "1TOKEN",
    "_TOKEN",
    "A-B",
    "A B",
    "A".repeat(65),
  ])
    expect(checkName(bad), bad).toBeDefined();
});

it("refuses the names the deploy and the container set", () => {
  for (const reserved of [
    "BUZZ_PRIVATE_KEY",
    "BUZZ_ANYTHING",
    "CLAUDE_CODE_X",
    "CLAUDEX",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_HOME",
    "HOME",
    "PATH",
  ])
    expect(checkName(reserved), reserved).toMatch(/is reserved/);
  expect(checkName("BUZZY")).toBeUndefined();
  expect(checkName("HOMEDIR")).toBeUndefined();
});

it("takes the characters an env file holds unquoted, up to 4096 bytes", () => {
  expect(checkValue("ghp_abc.DEF:1~2+3/4=5@6-7")).toBeUndefined();
  expect(checkValue("a".repeat(4096))).toBeUndefined();
  expect(checkValue("a".repeat(4097))).toMatch(/at most 4096 bytes/);
  expect(checkValue("")).toBe("Enter the value.");
  for (const bad of ["a b", 'a"b', "a'b", "a$b", "a\nb", "é"])
    expect(checkValue(bad), JSON.stringify(bad)).toMatch(
      /only letters, digits/,
    );
});

it("never repeats the value in what it says", () => {
  const value = "secret value with spaces";
  expect(checkValue(value)).not.toContain(value);
});

it("allows 63 secrets and refuses the 65th", () => {
  expect(checkRoom(63)).toBeUndefined();
  expect(checkRoom(64)).toBe("An agent may have at most 64 secrets.");
});

it("joins names the way a sentence does", () => {
  expect(list([])).toBe("");
  expect(list(["a"])).toBe("a");
  expect(list(["a", "b"])).toBe("a and b");
  expect(list(["a", "b", "c"])).toBe("a, b and c");
});

it("sorts the agents of a reply and writes the line for the ones that have the change", () => {
  const change = reached("Saved X.", [
    { agent: "a", applied: true, restarted: true },
    { agent: "b", applied: true, restarted: false },
    { agent: "c", applied: false, applyError: "down!" },
  ] as never);
  expect(change.failed).toEqual([{ agent: "c", reason: "Down." }]);
  expect(appliedLine(change)).toBe(
    "Saved X. a restarted, and a restarted agent restarts the work it is doing now. b did not need to restart.",
  );
  expect(appliedLine(reached("Saved X.", []))).toBe(
    "Saved X. No agent holds it yet, so no agent changed.",
  );
});
