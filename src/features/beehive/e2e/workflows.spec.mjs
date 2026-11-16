// The Workflows view against a real `buzz-hive`: the built-in packages are
// listed with their stages, and a broken package folder placed beside them shows
// the finding the engine reports for it. The kiln `list`, `browse` and `guide`
// specs test the package-management screens, which come in later phases (see
// crates/buzz-hive-core/PORTING.md in the Buzz checkout).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "../../../../tests/browser/playwright-test.mjs";
import { hiveUnavailable } from "./engine.mjs";
import { startWorld } from "./world.mjs";

test.skip(!!hiveUnavailable(), hiveUnavailable() ?? "");
test.describe.configure({ mode: "serial" });

const BUILT_INS = ["demo", "engineering", "openspec", "qrspi", "rpi", "task"];

let dir;
let world;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beehive-workflows-"));
  await mkdir(join(dir, "broken"));
  await writeFile(
    join(dir, "broken", "kiln-package.yaml"),
    "name: broken\nversion: 1.0.0\n",
  );
  await writeFile(
    join(dir, "broken", "workflow.yaml"),
    "version: 2\nstages:\n  - { id: a, kind: prompt, agent: builder, prompt: x, on: { passed: nowhere } }\n",
  );
  await mkdir(join(dir, "nameless"));
  await writeFile(
    join(dir, "nameless", "kiln-package.yaml"),
    "version: 1.0.0\n",
  );
  world = await startWorld({ workflowsDir: dir });
});
test.afterAll(async () => {
  await world?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("the engine lists the built-in packages, each with its stages", async () => {
  const { workflows } = await world.client().listWorkflows();
  const builtIn = workflows.filter((w) => w.builtin).map((w) => w.name);
  expect(builtIn).toEqual(BUILT_INS);
  for (const workflow of workflows.filter((w) => w.builtin)) {
    expect(workflow.ok, workflow.name).toBe(true);
    expect(workflow.stages.length, workflow.name).toBeGreaterThan(0);
  }
});

test("the page lists the built-in packages and their stages", async ({
  page,
}) => {
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("button", { name: "Workflows" }).click();
  for (const name of BUILT_INS) {
    const section = pane.getByRole("region", { name });
    await expect(section).toBeVisible();
    await expect(
      section.getByRole("list", { name: `Stages of ${name}` }),
    ).toBeVisible();
  }
  const demo = pane.getByRole("region", { name: "demo" });
  await expect(demo.getByText("Ready")).toBeVisible();
  await expect(demo.getByText("Built in")).toBeVisible();
});

test("a broken package shows its finding, and a nameless folder shows its own", async ({
  page,
}) => {
  await page.goto(world.pageUrl);
  const pane = page.getByRole("region", { name: "Beehive" });
  await pane.getByRole("button", { name: "Workflows" }).click();
  const broken = pane.getByRole("region", { name: "broken" });
  await expect(broken.getByText("Has problems")).toBeVisible();
  await expect(
    broken.getByRole("list", { name: "Findings for broken" }),
  ).toContainText("route_target_unknown");
  const unloaded = pane.getByRole("region", {
    name: "Packages that did not load",
  });
  await expect(unloaded).toContainText("nameless");
  await expect(
    unloaded.getByRole("list", { name: /Findings for/ }),
  ).toBeVisible();
  // The built-in packages are still listed and ready beside the broken one.
  await expect(
    pane.getByRole("region", { name: "demo" }).getByText("Ready"),
  ).toBeVisible();
});
