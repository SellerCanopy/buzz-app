// Generates the TypeScript types for the Beehive engine API from the proto
// that lives with the service in the Buzz repository.
//
//   BUZZ_HIVE_PROTO_DIR=/path/to/buzz/crates/buzz-hive-api/proto pnpm beehive:gen
//   pnpm beehive:gen:check    regenerates into a temp folder and fails on a diff
//
// Without BUZZ_HIVE_PROTO_DIR the script looks for a Buzz checkout beside this one.
// `--check` skips quietly when neither exists, so a checkout without Buzz can still
// run `pnpm check`. It fails when the variable is set to a folder that is missing.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const feature = join(root, "src/features/beehive");
const committed = join(feature, "gen");
const check = process.argv.includes("--check");

const fromEnv = process.env.BUZZ_HIVE_PROTO_DIR;
const protoDir = resolve(
  fromEnv ?? join(root, "../buzz/crates/buzz-hive-api/proto"),
);
if (!existsSync(protoDir)) {
  if (check && !fromEnv) {
    console.log(`beehive:gen:check skipped: no proto at ${protoDir}`);
    process.exit(0);
  }
  console.error(
    `Beehive proto folder not found: ${protoDir}\nSet BUZZ_HIVE_PROTO_DIR to buzz/crates/buzz-hive-api/proto.`,
  );
  process.exit(1);
}

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

  if (check) {
    const [want, have] = await Promise.all([
      snapshot(generated),
      snapshot(committed),
    ]);
    const paths = [...new Set([...want.keys(), ...have.keys()])].sort();
    const stale = paths.filter((path) => want.get(path) !== have.get(path));
    if (stale.length) {
      console.error(
        `src/features/beehive/gen is out of date (${stale.join(", ")}).\nRun: BUZZ_HIVE_PROTO_DIR=${protoDir} pnpm beehive:gen`,
      );
      process.exit(1);
    }
    console.log("beehive:gen:check ok");
  } else {
    await rm(committed, { recursive: true, force: true });
    await cp(generated, committed, { recursive: true });
    console.log(`Wrote ${relative(root, committed)}`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
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
