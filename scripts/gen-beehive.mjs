// Generates the TypeScript types for the Beehive engine API from the proto
// that lives with the service in the Buzz repository.
//
//   BUZZ_HIVE_PROTO_DIR=/path/to/buzz/crates/buzz-hive-api/proto pnpm beehive:gen
//   pnpm beehive:gen:check
//
// `beehive:gen` also writes gen/MANIFEST.json: the SHA-256 of the proto it read, the
// Buzz commit that proto came from, and the SHA-256 of every generated file.
//
// `--check` always compares the committed files with that manifest, so a hand
// edit fails on a checkout with no Buzz beside it, as CI is. When the proto is
// there too (BUZZ_HIVE_PROTO_DIR, or a Buzz checkout beside this one) it also
// regenerates into a temp folder and fails when the proto no longer matches the
// manifest or the output differs from the committed files. It fails when the
// variable is set to a folder that is missing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const feature = join(root, "src/features/beehive");
const committed = join(feature, "gen");
const manifestName = "MANIFEST.json";
const check = process.argv.includes("--check");

const fromEnv = process.env.BUZZ_HIVE_PROTO_DIR;
const protoDir = resolve(
  fromEnv ?? join(root, "../buzz/crates/buzz-hive-api/proto"),
);
const hasProto = existsSync(protoDir);
if (!hasProto && (!check || fromEnv)) {
  console.error(
    `Beehive proto folder not found: ${protoDir}\nSet BUZZ_HIVE_PROTO_DIR to buzz/crates/buzz-hive-api/proto.`,
  );
  process.exit(1);
}

const have = await snapshot(committed);
const problems = [];
let manifest;
if (check) {
  manifest = readManifest(have);
  if (manifest) {
    const files = hashes(have);
    const paths = new Set([
      ...Object.keys(manifest.files),
      ...Object.keys(files),
    ]);
    for (const path of [...paths].sort()) {
      if (manifest.files[path] !== files[path])
        problems.push(
          `${path} does not match ${manifestName} (edited by hand?)`,
        );
    }
  }
}

if (hasProto) {
  const scratch = await mkdtemp(join(tmpdir(), "beehive-gen-"));
  try {
    const result = spawnSync(
      join(root, "node_modules/.bin/buf"),
      [
        "generate",
        protoDir,
        "--template",
        join(feature, "buf.gen.yaml"),
        "-o",
        scratch,
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          PATH: `${join(root, "node_modules/.bin")}${delimiter}${process.env.PATH}`,
        },
      },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
    const generated = join(scratch, "gen");
    const want = await snapshot(generated);
    const proto = await protoDigest(protoDir);

    if (check) {
      if (manifest && manifest.protoSha256 !== proto) {
        problems.push(
          `the proto at ${protoDir} is not the one ${manifestName} records (${manifest.sourceCommit})`,
        );
      }
      const current = new Map(
        [...have].filter(([path]) => path !== manifestName),
      );
      const paths = [...new Set([...want.keys(), ...current.keys()])].sort();
      for (const path of paths) {
        if (want.get(path) !== current.get(path))
          problems.push(`${path} differs from what the proto generates`);
      }
    } else {
      await writeFile(
        join(generated, manifestName),
        `${JSON.stringify(
          {
            source: "crates/buzz-hive-api/proto in the Buzz repository",
            sourceCommit: sourceCommit(protoDir),
            protoSha256: proto,
            files: hashes(want),
          },
          null,
          2,
        )}\n`,
      );
      await rm(committed, { recursive: true, force: true });
      await cp(generated, committed, { recursive: true });
      console.log(`Wrote ${relative(root, committed)}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} else if (manifest) {
  console.log(
    `No proto at ${protoDir}: checked gen/ against ${manifestName} only (generated from ${manifest.sourceCommit}).`,
  );
}

if (check) {
  if (problems.length) {
    console.error(
      `src/features/beehive/gen is out of date:\n- ${problems.join("\n- ")}\nRun: BUZZ_HIVE_PROTO_DIR=${protoDir} pnpm beehive:gen`,
    );
    process.exit(1);
  }
  console.log("beehive:gen:check ok");
}

/** The parsed manifest, or `undefined` after recording why there is none. */
function readManifest(files) {
  const text = files.get(manifestName);
  if (text === undefined) {
    problems.push(`${manifestName} is missing`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed.protoSha256 === "string" &&
      parsed.files &&
      typeof parsed.files === "object"
    )
      return parsed;
  } catch {
    // Fall through to the problem below.
  }
  problems.push(`${manifestName} is not readable`);
  return undefined;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** SHA-256 of every generated file by relative path, leaving the manifest out. */
function hashes(files) {
  return Object.fromEntries(
    [...files]
      .filter(([path]) => path !== manifestName)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, text]) => [path, sha256(text)]),
  );
}

/** One SHA-256 over every file in the proto folder: its paths and contents. */
async function protoDigest(dir) {
  const files = await snapshot(dir);
  return sha256(
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, text]) => `${path}\0${sha256(text)}\n`)
      .join(""),
  );
}

/** The Buzz commit the proto folder is at, marked when it has uncommitted changes. */
function sourceCommit(dir) {
  const git = (...args) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) return "unknown";
  const dirty = git("status", "--porcelain", "--", ".").stdout.trim() !== "";
  return `${head.stdout.trim()}${dirty ? "+uncommitted" : ""}`;
}

/** Every file under `dir`, keyed by relative path. A missing folder is empty. */
async function snapshot(dir) {
  const files = new Map();
  if (!existsSync(dir)) return files;
  for (const entry of await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path), await readFile(path, "utf8"));
  }
  return files;
}
