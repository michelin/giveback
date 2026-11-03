/**
 * Build the list of files that make up the deployment package.
 *
 * An ALLOWLIST: the package is what the application reads at runtime and nothing else. A
 * blocklist would ship any new file by default, git-ignored local files included, since the
 * package is built from the working directory. The assertions at the bottom are a second guard,
 * for something that lands inside one of the allowed directories.
 *
 *   node scripts/build-package.mjs [--out dist]
 *
 * Writes <out>/package-files.txt, one path per line, ready for `zip -@`.
 */

import { writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "dist";

// Everything the application needs at runtime, and the whole of the package.
const SHIPPED = ["package.json", "package-lock.json", "src", "jobs", "views", "public", "node_modules"];

// Never in a package: macOS litter anywhere, and a dependency's own dotenv file (bottleneck
// publishes one), which nothing reads at runtime. Ours are not skipped but refused, below.
const isSkipped = (rel) => rel.endsWith(".DS_Store")
  || (rel.startsWith("node_modules/") && rel.split("/").pop().startsWith(".env"));

// Things that must never leave a workstation or a runner, at any depth. Checked on the result,
// so a secret dropped inside an allowed directory still stops the build.
const FORBIDDEN = [
  /(^|\/)\.env/, /(^|\/)id_rsa/, /\.(pem|key|p12|pfx|dump)$/,
  /^octokit\.js$/, /^\.git\//, /^test\//, /^test-support\//, /^docs\//, /^scripts\//,
];

const files = [];
const walk = (abs) => {
  const rel = relative(ROOT, abs).split(sep).join("/");

  if (isSkipped(rel)) {
    return;
  }

  if (statSync(abs).isDirectory()) {
    for (const entry of readdirSync(abs)) {
      walk(join(abs, entry));
    }
  } else {
    files.push(rel);
  }
};

const missing = SHIPPED.filter((entry) => !existsSync(join(ROOT, entry)));

for (const entry of SHIPPED.filter((e) => !missing.includes(e))) {
  walk(join(ROOT, entry));
}

const leaked = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));

if (missing.length > 0) {
  console.error(`the package is missing what the app needs to run: ${missing.join(", ")}`);
  process.exitCode = 1;
}

if (leaked.length > 0) {
  console.error(`the package contains files that must never be deployed:\n  ${leaked.slice(0, 20).join("\n  ")}`);
  process.exitCode = 1;
}

if (process.exitCode) {
  process.exit();
}

// resolve, not join: an absolute --out has to land where it was asked for. With join, a
// `--out /tmp/x` was rewritten to <repo>/tmp/x inside the working tree.
const outPath = resolve(ROOT, outDir);

mkdirSync(outPath, { recursive: true });
writeFileSync(join(outPath, "package-files.txt"), `${files.join("\n")}\n`);

const top = [...new Set(files.map((f) => f.split("/")[0]))].sort();

console.log(`${files.length} file(s) in the package: ${top.join(", ")}`);
