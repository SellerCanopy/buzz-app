// Fails when a file this fork edits in upstream code names something that belongs only to
// the private fork.
//
//   node scripts/check-private-names.mjs
//
// scripts/upstream-edits.txt lists every upstream file the fork edits. This repository is
// public, so those edits may only use example values and build settings (see AGENTS.md,
// "Open-source boundary"). Lines marked (fork-only) in the list name paths that belong to
// the fork alone and are not scanned. This script and its test must name the strings they
// look for, so they are never scanned even when listed.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/** Names that belong only to the private fork. Add a pattern here, not at a call site. */
export const PRIVATE_NAMES = [
  { label: "SellerCanopy", pattern: /sellercanopy/i },
  { label: "autopilotsellers", pattern: /autopilotsellers/i },
  { label: "kiln", pattern: /kiln/i },
  {
    label: "internal hostname",
    pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|intranet)\b/i,
  },
];

const SELF = new Set([
  "scripts/check-private-names.mjs",
  "scripts/check-private-names.test.mjs",
]);

/**
 * Reads the paths to scan from an upstream-edits list.
 *
 * Blank lines, `#` comments and lines marked `(fork-only)` are skipped. A path may be
 * followed by a note such as `(only if ...)`.
 *
 * @param {string} text Contents of scripts/upstream-edits.txt.
 * @returns {{ file: string, optional: boolean }[]} Paths to scan, relative to the repo root.
 */
export function listedFiles(text) {
  const files = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /\(fork-only\)/i.test(line)) continue;
    const file = line.split(/\s+/)[0];
    if (SELF.has(file)) continue;
    files.push({ file, optional: /\(only if/i.test(line) });
  }
  return files;
}

/**
 * Scans every listed upstream-edited file for private names.
 *
 * @param {string} root Repository root.
 * @param {string} [listPath] Upstream-edits list, relative to root.
 * @returns {{ file: string, line: number, label: string, text: string }[]} One entry per
 *   hit. A listed file that is missing and not marked `(only if ...)` is a hit with
 *   `line` 0, because a stale list stops protecting the file that replaced it.
 */
export function findPrivateNames(
  root,
  listPath = "scripts/upstream-edits.txt",
) {
  const hits = [];
  const list = readFileSync(path.join(root, listPath), "utf8");
  for (const { file, optional } of listedFiles(list)) {
    const full = path.join(root, file);
    if (!existsSync(full)) {
      if (!optional)
        hits.push({
          file,
          line: 0,
          label: "listed file is missing",
          text: "",
        });
      continue;
    }
    readFileSync(full, "utf8")
      .split("\n")
      .forEach((text, index) => {
        for (const { label, pattern } of PRIVATE_NAMES)
          if (pattern.test(text))
            hits.push({
              file,
              line: index + 1,
              label,
              text: text.trim().slice(0, 160),
            });
      });
  }
  return hits;
}

if (import.meta.main) {
  const root = process.argv[2] ?? path.join(scriptDir, "..");
  const hits = findPrivateNames(root);
  for (const { file, line, label, text } of hits)
    console.error(
      `${file}${line ? `:${line}` : ""}: ${label}${text ? `: ${text}` : ""}`,
    );
  if (hits.length) {
    console.error(
      `check-private-names: ${hits.length} hit(s) in files listed in scripts/upstream-edits.txt.`,
    );
    process.exit(1);
  }
  console.log(
    "check-private-names: no private names in upstream-edited files.",
  );
}
