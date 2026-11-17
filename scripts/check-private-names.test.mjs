import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { findPrivateNames, listedFiles } from "./check-private-names.mjs";

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "buzz-private-names-"));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "src"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (file, text) => writeFileSync(path.join(root, file), text);
const list = (...lines) =>
  write("scripts/upstream-edits.txt", lines.join("\n"));

it("passes a listed file that uses example values", () => {
  write("src/a.ts", 'const url = "https://app.example.org/beehive";\n');
  list("# Upstream edits", "", "src/a.ts");
  expect(findPrivateNames(root)).toEqual([]);
});

it("fails a listed file with a private name and reports file and line", () => {
  write("src/a.ts", "const ok = 1;\nconst brand = 'SellerCanopy';\n");
  write("src/b.ts", "// sellercanopy lower case\n// Kiln engine\n");
  write("src/c.ts", 'const host = "db.prod.internal";\n');
  list("src/a.ts", "src/b.ts", "src/c.ts");
  const hits = findPrivateNames(root).map(({ file, line, label }) => ({
    file,
    line,
    label,
  }));
  expect(hits).toEqual([
    { file: "src/a.ts", line: 2, label: "SellerCanopy" },
    { file: "src/b.ts", line: 1, label: "SellerCanopy" },
    { file: "src/b.ts", line: 2, label: "kiln" },
    { file: "src/c.ts", line: 1, label: "internal hostname" },
  ]);
});

it("ignores a file that is not in the list", () => {
  write("src/a.ts", "const ok = 1;\n");
  write("src/fork.ts", "const brand = 'SellerCanopy';\n");
  list("src/a.ts");
  expect(findPrivateNames(root)).toEqual([]);
});

it("skips lines marked fork-only", () => {
  write("src/a.ts", "const ok = 1;\n");
  write("src/fork.ts", "const brand = 'SellerCanopy';\n");
  list("src/a.ts", "src/fork.ts  (fork-only)");
  expect(findPrivateNames(root)).toEqual([]);
});

it("never scans the check script or its test", () => {
  expect(
    listedFiles(
      "scripts/check-private-names.mjs\nscripts/check-private-names.test.mjs\nsrc/a.ts",
    ),
  ).toEqual([{ file: "src/a.ts", optional: false }]);
});

it("fails a listed file that is missing unless it is marked only-if", () => {
  list("src/gone.ts", "src/maybe.ts  (only if a later phase needed it)");
  expect(findPrivateNames(root)).toEqual([
    {
      file: "src/gone.ts",
      line: 0,
      label: "listed file is missing",
      text: "",
    },
  ]);
});
