// Checks the output of `pnpm build:beehive-standalone`, which the engine serves at /beehive/.
//
//   pnpm build:beehive-standalone && node scripts/check-beehive-standalone.mjs
//
// The page loads inside an app web view under the engine's own content policy, so it fails when
// the built document has an inline script, when any URL in it or its CSS leaves /beehive/, or
// when the CSS inlines a font as a data: URL.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = "dist-beehive";
const BASE = "/beehive/";
const problems = [];

const html = await readFile(join(OUT, "index.html"), "utf8").catch(() => {
  console.error(
    `${OUT}/index.html is missing. Run pnpm build:beehive-standalone first.`,
  );
  process.exit(1);
});
// Comments may mention scripts and URLs without loading them.
const document = html.replace(/<!--[\s\S]*?-->/g, "");

for (const [, attributes] of document.matchAll(/<script\b([^>]*)>/gi))
  if (!/\bsrc\s*=/.test(attributes))
    problems.push("index.html has an inline <script>");
if (/\son[a-z]+\s*=/i.test(document))
  problems.push("index.html has an inline event handler");
for (const [, , , url] of document.matchAll(
  /\b(src|href|action|poster)\s*=\s*(["'])(.*?)\2/gi,
))
  if (!url.startsWith(BASE))
    problems.push(`index.html has a URL outside ${BASE}: ${url}`);
  else if (!existsSync(join(OUT, url.slice(BASE.length))))
    problems.push(`index.html names a file the build did not write: ${url}`);

const assets = await readdir(join(OUT, "assets"));
for (const name of assets.filter((file) => file.endsWith(".css"))) {
  const css = await readFile(join(OUT, "assets", name), "utf8");
  for (const [, , url] of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (/^data:/i.test(url)) {
      if (/^data:[^;,]*(font|woff|ttf|otf|octet-stream)/i.test(url))
        problems.push(`${name} inlines a font as a data: URL`);
    } else if (!url.startsWith("#")) {
      // A relative URL resolves against the stylesheet's own place under /beehive/assets/.
      const path = new URL(url, `http://page${BASE}assets/${name}`).pathname;
      if (!path.startsWith(BASE))
        problems.push(`${name} has a URL outside ${BASE}: ${url}`);
      else if (!existsSync(join(OUT, path.slice(BASE.length))))
        problems.push(`${name} names a file the build did not write: ${url}`);
    }
  }
}

if (problems.length) {
  for (const problem of new Set(problems)) console.error(problem);
  process.exit(1);
}
console.log(
  `${OUT} is served from ${BASE}: no inline script, no stray URL, no data: font.`,
);
