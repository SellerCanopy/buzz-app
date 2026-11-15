// Starts a real `buzz-hive` for the browser and Node specs, on a scratch
// database, and stops it again. Ported from kiln's `startEngine`
// (app/e2e/engine.ts): the same shape, `{ url, stop, restart }`, without the
// flags a Buzz-hosted engine no longer has.
//
// Inputs, all from the environment:
//   BUZZ_HIVE_CHECKOUT           the Buzz checkout that holds `buzz-hive` (required)
//   BUZZ_HIVE_E2E_DATABASE_URL   a scratch database that already has the relay
//                                schema and a `communities` row for the host
//                                below (required)
//   BUZZ_HIVE_E2E_COMMUNITY_HOST that community's host (default `localhost`)
//   BUZZ_HIVE_E2E_PSQL           optional: a command that runs SQL from stdin
//                                against that database, such as
//                                `docker exec -i <container> psql -U buzz -d buzz -v ON_ERROR_STOP=1`.
//                                Given one, `startHive` empties the `hive`
//                                schema and seeds the test key as a member.
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SECRET = "e2e-only-secret-e2e-only-secret-0123456789";

/** Why a spec cannot run here, or `undefined` when it can. */
export function hiveUnavailable() {
  if (!process.env.BUZZ_HIVE_CHECKOUT) return "BUZZ_HIVE_CHECKOUT is not set";
  if (!process.env.BUZZ_HIVE_E2E_DATABASE_URL)
    return "BUZZ_HIVE_E2E_DATABASE_URL is not set";
  return undefined;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let built;
/** Build `buzz-hive` once and return the path of its binary. */
function build(checkout) {
  built ??= run(
    join(checkout, "bin", "cargo"),
    ["build", "-p", "buzz-hive", "--message-format=json"],
    { cwd: checkout, maxBuffer: 256 * 1024 * 1024 },
  ).then(({ stdout }) => {
    const artifact = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(
        (message) =>
          message.reason === "compiler-artifact" &&
          message.target?.name === "buzz-hive" &&
          message.executable,
      );
    if (!artifact) throw new Error("cargo did not build buzz-hive");
    return artifact.executable;
  });
  return built;
}

/** Run SQL through BUZZ_HIVE_E2E_PSQL, when one is configured. */
async function sql(text) {
  const command = process.env.BUZZ_HIVE_E2E_PSQL?.trim();
  if (!command) return;
  const [program, ...args] = command.split(/\s+/);
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`psql failed: ${stderr}`)),
    );
    child.stdin.end(text);
  });
}

async function ready(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`buzz-hive exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("buzz-hive did not become ready");
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
}

/**
 * Start `buzz-hive` on the scratch database.
 *
 * @param {object} [options]
 * @param {string[]} [options.allowedOrigins] browser origins the engine allows
 * @param {string} [options.member] a public key (hex) to seed as a relay member
 * @param {"owner"|"admin"|"member"} [options.role] that member's relay role
 * @param {string} [options.workflowsDir] a folder of extra workflow packages to load
 * @returns {Promise<{ url: string, stop(): Promise<void>, restart(): Promise<void> }>}
 */
export async function startHive({
  allowedOrigins = [],
  member,
  role = "member",
  workflowsDir,
} = {}) {
  const missing = hiveUnavailable();
  if (missing) throw new Error(missing);
  const checkout = process.env.BUZZ_HIVE_CHECKOUT;
  const host = process.env.BUZZ_HIVE_E2E_COMMUNITY_HOST ?? "localhost";
  if (!/^[a-z0-9.:-]+$/i.test(host)) throw new Error("bad community host");
  await sql("DROP SCHEMA IF EXISTS hive CASCADE;\n");
  if (member) {
    if (!/^[0-9a-f]{64}$/.test(member)) throw new Error("bad member key");
    await sql(
      `INSERT INTO public.relay_members (community_id, pubkey, role)
       SELECT id, '${member}', '${role}' FROM public.communities WHERE host = '${host}'
       ON CONFLICT (community_id, pubkey) DO UPDATE SET role = EXCLUDED.role;\n`,
    );
  }
  const binary = await build(checkout);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const launch = () =>
    spawn(binary, [], {
      cwd: checkout,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        BUZZ_HIVE_DATABASE_URL: process.env.BUZZ_HIVE_E2E_DATABASE_URL,
        BUZZ_HIVE_LISTEN: `127.0.0.1:${port}`,
        BUZZ_HIVE_PUBLIC_URL: url,
        BUZZ_HIVE_TOKEN_SECRET: SECRET,
        BUZZ_HIVE_COMMUNITY_HOST: host,
        BUZZ_HIVE_ALLOWED_ORIGINS: allowedOrigins.join(","),
        ...(workflowsDir ? { BUZZ_HIVE_WORKFLOWS_DIR: workflowsDir } : {}),
      },
    });
  /** Launch the engine and wait for it; one that never becomes ready is stopped, not left running. */
  const launched = async () => {
    const started = launch();
    try {
      await ready(url, started);
    } catch (error) {
      await stopChild(started);
      throw error;
    }
    return started;
  };
  let child = await launched();
  return {
    url,
    stop: () => stopChild(child),
    /** Stop and start again on the same port and database. */
    async restart() {
      await stopChild(child);
      child = await launched();
    },
  };
}
